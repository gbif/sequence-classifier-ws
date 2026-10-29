/**
 * vsearchClient.mjs
 *
 * Talks to the vsearch batch search server and parses its output.
 *
 * Every call goes through one per-process queue (p-queue), and large requests are split
 * into fixed-size chunks, so vsearch only ever sees a bounded amount of work
 * from this process no matter how many requests arrive at once. A chunk that
 * fails with a network error or 5xx is retried with backoff; one bad
 * chunk no longer fails a whole batch on the first hiccup.
 */

import PQueue from 'p-queue';

// Field order matches the 23-field pipe-separated FASTA header
const HEADER_FIELDS = [
  'id', 'accessionNumber', 'scientificName',
  'decimalLatitude', 'decimalLongitude', 'typeStatus',
  'catalogueNumber', 'identifiedBy', 'taxonRank',
  'country', 'locality', 'basisOfRecord',
  'higherClassification', 'dataset', 'targetGene',
  'domain', 'kingdom', 'phylum', 'class', 'order', 'family', 'genus', 'species',
];

export function parseTargetHeader(header) {
  const parts = header.split('|');
  const obj = {};
  HEADER_FIELDS.forEach((field, i) => {
    obj[field] = (parts[i] || '').replace(/_/g, ' ');
  });
  return obj;
}

// Keeps the raw header on the match for the cache, without adding it to the
// JSON the API returns.
export function withHeader(match, header) {
  return Object.defineProperty(match, 'header', { value: header, enumerable: false });
}

export function parseFasta(text) {
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

export function parseBlast6out(text, sequences) {
  const results = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if (cols.length < 12) continue;
    const queryId = cols[0];
    const match = parseTargetHeader(cols[1]);
    withHeader(match, cols[1]);
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

export function parseAlnout(text, sequences) {
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

// ── client ───────────────────────────────────────────────────────────────────

export function toFasta(seqs) {
  return Object.entries(seqs).map(([id, seq]) => `>${id}\n${seq}`).join('\n');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Retry only failures that a second attempt can fix:
// - 4xx means the request itself is wrong.
// - A timeout means vsearch is behind. Each replica works through one request
//   at a time and keeps going on a request the client abandoned, so a retry
//   would only add load to a server that is already overloaded.
const isRetryable = err =>
  err.name !== 'TimeoutError' && !(err.status >= 400 && err.status < 500 && err.status !== 429);

/**
 * @param {object} opts
 * @param {string} opts.url          vsearch batch endpoint
 * @param {number} opts.timeoutMs    per-chunk request timeout
 * @param {number} opts.batchSize    sequences per vsearch request
 * @param {number} opts.concurrency  vsearch requests in flight from this process
 * @param {number} opts.retries      extra attempts per chunk after the first
 * @param {boolean} [opts.logQueue]  log every queue add/finish
 * @param {Function} [opts.fetch]    injected for tests
 */
export function createVsearchClient({
  url, timeoutMs, batchSize, concurrency, retries, logQueue = false, fetch = globalThis.fetch,
}) {
  const queue = new PQueue({ concurrency });
  // Per-chunk queue logging, for debugging. Off by default: at backfill volume
  // it is two lines per chunk.
  if (logQueue) {
    queue.on('add',  () => console.log(`vsearch queue: added. Waiting: ${queue.size}, running: ${queue.pending}`));
    queue.on('next', () => console.log(`vsearch queue: finished one. Waiting: ${queue.size}, running: ${queue.pending}`));
  }

  async function postChunk(fasta, outfmt) {
    const res = await fetch(`${url}?outfmt=${outfmt}`, {
      method: 'POST',
      body: fasta,
      headers: { 'Content-Type': 'text/plain' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`vsearch error ${res.status}: ${text}`);
      err.status = res.status;
      throw err;
    }
    return text;
  }

  async function searchChunk(seqs, outfmt) {
    const fasta = toFasta(seqs);
    for (let attempt = 0; ; attempt++) {
      try {
        const text = await queue.add(() => postChunk(fasta, outfmt));
        return outfmt === 'blast6out' ? parseBlast6out(text, seqs) : parseAlnout(text, seqs);
      } catch (err) {
        if (attempt >= retries || !isRetryable(err)) throw err;
        // Exponential backoff with jitter, outside the queue so a waiting
        // retry does not hold a slot other chunks could use.
        await sleep(500 * 2 ** attempt * (0.5 + Math.random()));
      }
    }
  }

  /**
   * Search sequences, chunked and rate-limited.
   *
   * @param {Object<string,string>} seqs  id → sequence
   * @param {'blast6out'|'alnout'} [outfmt]
   * @returns {Promise<Object<string,object[]>>} id → matches; ids with no hits are absent
   */
  async function search(seqs, outfmt = 'blast6out') {
    const ids = Object.keys(seqs);
    const chunks = [];
    for (let i = 0; i < ids.length; i += batchSize) {
      chunks.push(Object.fromEntries(ids.slice(i, i + batchSize).map(id => [id, seqs[id]])));
    }
    const parsed = await Promise.all(chunks.map(c => searchChunk(c, outfmt)));
    return Object.assign({}, ...parsed);
  }

  return { search };
}
