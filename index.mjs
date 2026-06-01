import express from 'express';
import { createRequire } from 'module';
import { pickBestMatch } from './pickBestMatch.mjs';
import { assignTaxonomyToOccurrence } from './assignTaxonomyToOccurrence.mjs';

const _require = createRequire(import.meta.url);
const cache = _require('./caches/index.js');
const CACHE_DB = _require('./caches/config.js').CACHE.dataBaseName;

const selectorCache = new Map();
selectorCache.set('pickBestMatch', pickBestMatch);

async function loadSelector(name) {
  if (selectorCache.has(name)) return selectorCache.get(name);
  if (!/^\w+$/.test(name)) throw new Error(`Invalid selector name: ${name}`);
  const mod = await import(new URL(`./${name}.mjs`, import.meta.url));
  const fn = mod[name];
  if (typeof fn !== 'function') throw new Error(`Module ${name}.mjs does not export a function named '${name}'`);
  selectorCache.set(name, fn);
  return fn;
}

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
app.use(express.json({ limit: '10mb' }));                    // for /occurrence/classify
app.use(express.text({ type: 'text/*', limit: '50mb' }));   // for /search/batch

app.post('/search/batch', async (req, res) => {
  const outfmt = req.query.outfmt || 'blast6out';
  if (!['blast6out', 'alnout'].includes(outfmt)) {
    return res.status(400).json({ error: `Unknown outfmt: ${outfmt}` });
  }

  const selectorName = req.query.selector || 'pickBestMatch';
  let selector;
  try {
    selector = await loadSelector(selectorName);
  } catch (err) {
    return res.status(400).json({ error: err.message });
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
    Object.entries(parsed).map(([queryId, matches]) => [queryId, selector(queryId, matches)])
  );

  res.json(result);
});

// ── shared vsearch helper ─────────────────────────────────────────────────────

async function vsearchQuery(fasta) {
  const vsearchRes = await fetch(`${VSEARCH_URL}?outfmt=blast6out`, {
    method: 'POST',
    body: fasta,
    headers: { 'Content-Type': 'text/plain' },
  });
  if (!vsearchRes.ok) {
    const text = await vsearchRes.text();
    throw new Error(`vsearch error ${vsearchRes.status}: ${text}`);
  }
  const text = await vsearchRes.text();
  return parseBlast6out(text, parseFasta(fasta));
}

async function cacheLookup(id) {
  try { return await cache.get(id, CACHE_DB); }
  catch { return null; }
}

async function cacheWrite(id, matches) {
  const top25 = [...matches]
    .sort((a, b) => (b.identity - a.identity) || (b.qcovs - a.qcovs))
    .slice(0, 25);
  try { await cache.set(id, CACHE_DB, top25); }
  catch { /* non-fatal */ }
}

async function vsearchQueryWithCache(fasta) {
  const seqs = parseFasta(fasta);
  const ids = Object.keys(seqs);

  const lookups = await Promise.all(ids.map(async id => [id, await cacheLookup(id)]));
  const matchesMap = {};
  const missIds = [];
  for (const [id, cached] of lookups) {
    if (cached !== null) matchesMap[id] = cached;
    else missIds.push(id);
  }

  if (missIds.length > 0) {
    const missFasta = missIds.map(id => `>${id}\n${seqs[id]}`).join('\n');
    const fresh = await vsearchQuery(missFasta);
    await Promise.all(
      Object.entries(fresh).map(async ([id, matches]) => {
        await cacheWrite(id, matches);
        matchesMap[id] = matches;
      })
    );
  }

  return matchesMap;
}

// ── POST /occurrence/classify ─────────────────────────────────────────────────
//
// Accept a single GBIF occurrence object (JSON), extract its nucleotide
// sequences, run vsearch for each, and return a DnaClassification that the
// GBIF pipeline can feed to the taxon-matching service.
//
// Request body: a GBIF occurrence object (Content-Type: application/json).
//
// Response (200):
//   { scientificName, taxonRank, [kingdom, phylum, class, order, family, genus, species], remarks }
//
// Response (204): occurrence had no sequences or no matches were found.
//
// Response (400): malformed request body.
//
app.post('/occurrence/classify', async (req, res) => {
  const occurrence = req.body;

  if (!occurrence || typeof occurrence !== 'object') {
    return res.status(400).json({ error: 'Request body must be a JSON occurrence object' });
  }

  let classification;
  try {
    classification = await assignTaxonomyToOccurrence(occurrence, vsearchQueryWithCache);
  } catch (err) {
    console.error('Classification error:', err.message);
    return res.status(502).json({ error: 'Classification failed', details: err.message });
  }

  if (classification === null) {
    return res.status(204).end();
  }

  res.json(classification);
});

// ── POST /occurrence/classify/batch ──────────────────────────────────────────
//
// Accept an array of GBIF occurrence objects, classify all of them in a single
// vsearch round-trip by deduplicating sequences across occurrences before
// querying, then fanning results back to each occurrence.
//
// Request body: occurrence[] (Content-Type: application/json).
//
// Response (200): array of result objects, one per input occurrence, in order:
//   { gbifID, classification }
//   classification is null if the occurrence had no sequences or no matches.
//
// Response (400): malformed request body.
//
app.post('/occurrence/classify/batch', async (req, res) => {
  const occurrences = req.body;

  if (!Array.isArray(occurrences)) {
    return res.status(400).json({ error: 'Request body must be an array of occurrence objects' });
  }

  // Collect unique sequences across all occurrences.
  const seqMap = new Map(); // nucleotideSequenceID → sequence string
  for (const occ of occurrences) {
    const entries = occ.nucleotideSequence;
    if (!Array.isArray(entries)) continue;
    for (const { nucleotideSequenceID, sequence, invalid } of entries) {
      if (sequence && !invalid && !seqMap.has(nucleotideSequenceID)) {
        seqMap.set(nucleotideSequenceID, sequence);
      }
    }
  }

  // Single vsearch call covering all unique sequences.
  let matchesMap = {};
  if (seqMap.size > 0) {
    const fasta = [...seqMap.entries()].map(([id, seq]) => `>${id}\n${seq}`).join('\n');
    try {
      matchesMap = await vsearchQueryWithCache(fasta);
    } catch (err) {
      console.error('Batch vsearch error:', err.message);
      return res.status(502).json({ error: 'Could not reach vsearch server', details: err.message });
    }
  }

  // For each occurrence, inject a lookup-based searchSequences so
  // assignTaxonomyToOccurrence resolves from the cached matchesMap.
  const results = await Promise.all(
    occurrences.map(async (occurrence) => {
      async function searchSequences(fasta) {
        const ids = Object.keys(parseFasta(fasta));
        return Object.fromEntries(ids.map(id => [id, matchesMap[id] ?? []]));
      }
      try {
        const classification = await assignTaxonomyToOccurrence(occurrence, searchSequences);
        return { gbifID: occurrence.gbifID ?? null, classification };
      } catch (err) {
        return { gbifID: occurrence.gbifID ?? null, classification: null, error: err.message };
      }
    })
  );

  res.json(results);
});

app.listen(PORT, () => {
  console.log(`vsearch proxy listening on http://localhost:${PORT}`);
  console.log(`Forwarding to ${VSEARCH_URL}`);
});
