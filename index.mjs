import express from 'express';
import { pickBestMatch } from './pickBestMatch.mjs';

const VSEARCH_URL = process.env.VSEARCH_URL || 'http://0.0.0.0:8000/search/batch';
const PORT = process.env.PORT || 3000;

// Field order matches the 23-field pipe-separated FASTA header
const HEADER_FIELDS = [
  'id', 'accessionNumber', 'scientificName',
  'decimalLatitude', 'decimalLongitude', 'typeStatus',
  'catalogueNumber', 'identifiedBy', 'taxonRank',
  'country', 'locality', 'basisOfRecord',
  'higherClassification', 'dataset', 'targetGene',
  'domain', 'kingdom', 'phylum', 'class', 'order', 'family', 'genus', 'species',
];

function parseTargetHeader(header) {
  const parts = header.split('|');
  const obj = {};
  HEADER_FIELDS.forEach((field, i) => {
    obj[field] = (parts[i] || '').replace(/_/g, ' ');
  });
  return obj;
}

function parseFasta(text) {
  const seqs = {};
  let id = null;
  let bases = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('>')) {
      if (id !== null) seqs[id] = bases.join('');
      id = line.slice(1).trim();
      bases = [];
    } else {
      bases.push(line.trim());
    }
  }
  if (id !== null) seqs[id] = bases.join('');
  return seqs;
}

// ── blast6out parser ─────────────────────────────────────────────────────────

function parseBlast6out(text, sequences) {
  const results = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if (cols.length < 12) continue;
    const queryId = cols[0];
    const match = parseTargetHeader(cols[1]);
    match.identity        = parseFloat(cols[2]);
    match.alignmentLength = parseInt(cols[3]);
    match.mismatches      = parseInt(cols[4]);
    match.gapOpenings     = parseInt(cols[5]);
    match.qstart          = parseInt(cols[6]);
    match.qend            = parseInt(cols[7]);
    match.sstart          = parseInt(cols[8]);
    match.send            = parseInt(cols[9]);
    match.evalue          = parseFloat(cols[10]);
    match.bitScore        = parseFloat(cols[11]);
    const qLen = sequences[queryId]?.length;
    match.qcovs = qLen
      ? Math.round((match.alignmentLength / qLen) * 1000) / 10
      : -1;
    if (!results[queryId]) results[queryId] = [];
    results[queryId].push(match);
  }
  return results;
}

// ── alnout parser ────────────────────────────────────────────────────────────

function parseAlnout(text, sequences) {
  const results = {};

  // Split into per-query blocks; prepend \n so the first "Query >" also matches
  const blocks = ('\n' + text).split('\nQuery >').slice(1);

  for (const block of blocks) {
    const lines = block.split('\n');
    const queryId = lines[0].trim();
    const qLen = sequences[queryId]?.length;

    // Summary table: "%Id   TLen  Target" header, then one row per match until blank line
    const hIdx = lines.findIndex(l => l.trim().startsWith('%Id'));
    if (hIdx === -1) continue;

    const summaryRows = [];
    for (let i = hIdx + 1; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l) break;
      const cols = l.split(/\s+/);
      summaryRows.push({
        identity:     parseFloat(cols[0]),   // already numeric, % sign stripped by parseInt if present
        targetLen:    parseInt(cols[1]),
        targetHeader: cols.slice(2).join(' '),
      });
    }

    // Alignment sub-blocks: each begins with " Query Xnt >" (leading space, then "Query Xnt >")
    // Split on that pattern to get one chunk per alignment
    const alnMap = {};  // targetHeader → { alignmentLength, alignment }
    const alnChunks = block.split(/\n Query \d+nt >/).slice(1);
    for (const chunk of alnChunks) {
      const chunkLines = chunk.split('\n');
      const targetLine = chunkLines.find(l => l.startsWith('Target '));
      if (!targetLine) continue;
      const targetHeader = targetLine.split('>')[1]?.trim();
      if (!targetHeader) continue;
      // Stats summary line: "X cols, X ids (X%), X gaps (X%)"
      const statsLine = [...chunkLines].reverse().find(l => /^\d+ cols,/.test(l.trim()));
      let alignmentLength = 0;
      if (statsLine) {
        const m = statsLine.trim().match(/^(\d+) cols/);
        if (m) alignmentLength = parseInt(m[1]);
      }
      alnMap[targetHeader] = { alignmentLength, alignment: ' Query ' + chunk };
    }

    const matches = [];
    for (const { identity, targetLen, targetHeader } of summaryRows) {
      const match = parseTargetHeader(targetHeader);
      const aln = alnMap[targetHeader];
      const alignmentLength = aln?.alignmentLength || 0;
      match.identity        = identity;
      match.targetLen       = targetLen;
      match.alignmentLength = alignmentLength;
      match.qcovs = qLen && alignmentLength
        ? Math.round((alignmentLength / qLen) * 1000) / 10
        : -1;
      if (aln?.alignment) match.alignment = aln.alignment;
      matches.push(match);
    }

    if (matches.length > 0) results[queryId] = matches;
  }

  return results;
}

// ── Express server ───────────────────────────────────────────────────────────

const app = express();
app.use(express.text({ type: '*/*', limit: '50mb' }));

app.post('/search/batch', async (req, res) => {
  const outfmt = req.query.outfmt || 'blast6out';
  if (!['blast6out', 'alnout'].includes(outfmt)) {
    return res.status(400).json({ error: `Unknown outfmt: ${outfmt}` });
  }

  const body = req.body;
  if (!body) return res.status(400).json({ error: 'No FASTA body provided' });

  const sequences = parseFasta(body);

  let vsearchRes;
  try {
    vsearchRes = await fetch(`${VSEARCH_URL}?outfmt=${outfmt}`, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'text/plain' },
    });
  } catch (err) {
    console.error('Upstream error:', err.message);
    return res.status(502).json({ error: 'Could not reach vsearch server', details: err.message });
  }

  if (!vsearchRes.ok) {
    const text = await vsearchRes.text();
    return res.status(502).json({ error: 'vsearch server error', status: vsearchRes.status, details: text });
  }

  const text = await vsearchRes.text();
  const parsed = outfmt === 'blast6out'
    ? parseBlast6out(text, sequences)
    : parseAlnout(text, sequences);

  const result = Object.fromEntries(
    Object.entries(parsed).map(([queryId, matches]) => [queryId, pickBestMatch(queryId, matches)])
  );

  res.json(result);
});

app.listen(PORT, () => {
  console.log(`vsearch proxy listening on http://localhost:${PORT}`);
  console.log(`Forwarding to ${VSEARCH_URL}`);
});
