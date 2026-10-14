// Minimal stand-in for POST /occurrence/classify/batch, so a client can be built
// while the real service is undeployed. Serves the captured fixture.
//
//   node test-data/responses/mock-server.mjs        # listens on 3001
//   PORT=4000 node test-data/responses/mock-server.mjs
//
// It preserves the contract that matters: one response entry per input
// occurrence, in input order. gbifIDs present in the fixture return their real
// captured classification; anything else returns classification: null, which is
// what the live service does for an occurrence with no match.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, 'classify-batch.response.json'), 'utf8'));
const byId = new Map(fixture.map(e => [String(e.gbifID), e.classification]));
const PORT = process.env.PORT || 3001;

createServer((req, res) => {
  const json = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (req.method === 'GET' && req.url === '/health') {
    return json(200, { status: 'ok', vsearch: 'ok', cache: 'ok' });
  }
  if (req.method !== 'POST' || !req.url.startsWith('/occurrence/classify/batch')) {
    return json(404, { error: 'Not found' });
  }

  let raw = '';
  req.on('data', c => (raw += c));
  req.on('end', () => {
    let occurrences;
    try {
      occurrences = JSON.parse(raw);
    } catch {
      return json(400, { error: 'Malformed JSON in request body' });
    }
    if (!Array.isArray(occurrences)) {
      return json(400, { error: 'Request body must be an array of occurrence objects' });
    }
    json(200, occurrences.map(o => ({
      gbifID: o.gbifID,
      classification: byId.get(String(o.gbifID)) ?? null,
    })));
  });
}).listen(PORT, () => console.log(`mock classify/batch on http://localhost:${PORT}`));
