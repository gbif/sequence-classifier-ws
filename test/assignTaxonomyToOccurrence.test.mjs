import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignTaxonomyToOccurrence } from '../assignTaxonomyToOccurrence.mjs';

// Minimal match factory — all fields compileClassification reads.
const match = (overrides) => ({
  identity:       100,
  qcovs:          100,
  scientificName: 'Agaricus bisporus',
  taxonRank:      'SPECIES',
  dataset:        'unite',
  targetGene:     'ITS_region',
  kingdom:        'Fungi',
  phylum:         '',
  class:          '',
  order:          '',
  family:         'Agaricaceae',
  genus:          'Agaricus',
  species:        'Agaricus bisporus',
  ...overrides,
});

// Minimal occurrence factory.
const occurrence = (seqs, extra = {}) => ({
  gbifID: 'test-occ-1',
  nucleotideSequence: seqs,
  ...extra,
});

// Mock searchSequences: returns a pre-built matchMap regardless of FASTA input.
const mockSearch = (matchMap) => async () => matchMap;

// ── Null / empty cases ────────────────────────────────────────────────────────

test('returns null when occurrence has no nucleotideSequence array', async () => {
  const result = await assignTaxonomyToOccurrence({}, mockSearch({}));
  assert.equal(result, null);
});

test('returns null when all sequences are invalid', async () => {
  const occ = occurrence([
    { nucleotideSequenceID: 'seq1', sequence: 'ACGT', invalid: true },
  ]);
  const result = await assignTaxonomyToOccurrence(occ, mockSearch({}));
  assert.equal(result, null);
});

test('returns null when sequences have no vsearch matches', async () => {
  const occ = occurrence([{ nucleotideSequenceID: 'seq1', sequence: 'ACGT' }]);
  const result = await assignTaxonomyToOccurrence(occ, mockSearch({ seq1: [] }));
  assert.equal(result, null);
});

// ── Single sequence ───────────────────────────────────────────────────────────

test('single sequence: top match species becomes the classification', async () => {
  const occ = occurrence([{ nucleotideSequenceID: 'seq1', sequence: 'ACGT' }]);
  const result = await assignTaxonomyToOccurrence(occ, mockSearch({
    seq1: [match({ species: 'Agaricus bisporus', identity: 100 })],
  }));
  assert.equal(result.species, 'Agaricus bisporus');
  assert.equal(result.taxonRank, 'SPECIES');
});

test('single sequence: classification includes higher taxonomy', async () => {
  const occ = occurrence([{ nucleotideSequenceID: 'seq1', sequence: 'ACGT' }]);
  const result = await assignTaxonomyToOccurrence(occ, mockSearch({
    seq1: [match({ kingdom: 'Fungi', family: 'Agaricaceae', genus: 'Agaricus' })],
  }));
  assert.equal(result.kingdom, 'Fungi');
  assert.equal(result.family, 'Agaricaceae');
  assert.equal(result.genus, 'Agaricus');
});

// ── Multiple sequences ────────────────────────────────────────────────────────

test('multiple sequences: sequence with highest identity wins', async () => {
  const occ = occurrence([
    { nucleotideSequenceID: 'seq1', sequence: 'ACGT' },
    { nucleotideSequenceID: 'seq2', sequence: 'TTTT' },
  ]);
  const result = await assignTaxonomyToOccurrence(occ, mockSearch({
    seq1: [match({ species: 'Low identity species',  identity: 95 })],
    seq2: [match({ species: 'High identity species', identity: 100 })],
  }));
  assert.equal(result.species, 'High identity species');
});

test('multiple sequences: remarks records all matched sequences', async () => {
  const occ = occurrence([
    { nucleotideSequenceID: 'seq1', sequence: 'ACGT' },
    { nucleotideSequenceID: 'seq2', sequence: 'TTTT' },
  ]);
  const result = await assignTaxonomyToOccurrence(occ, mockSearch({
    seq1: [match({ identity: 95, targetGene: 'ITS_region' })],
    seq2: [match({ identity: 100, targetGene: 'rbcL' })],
  }));
  assert.ok(result.remarks.includes('seq1'));
  assert.ok(result.remarks.includes('seq2'));
});

// ── Invalid sequence filtering ────────────────────────────────────────────────

test('invalid sequences are excluded before querying', async () => {
  const occ = occurrence([
    { nucleotideSequenceID: 'seq1', sequence: 'ACGT', invalid: true },
    { nucleotideSequenceID: 'seq2', sequence: 'TTTT' },
  ]);
  let queriedIds = [];
  const trackingSearch = async (fasta) => {
    queriedIds = fasta.split('\n').filter(l => l.startsWith('>')).map(l => l.slice(1));
    return { seq2: [match({})] };
  };
  await assignTaxonomyToOccurrence(occ, trackingSearch);
  assert.deepEqual(queriedIds, ['seq2']);
});
