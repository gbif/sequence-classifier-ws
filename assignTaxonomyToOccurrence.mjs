/**
 * assignTaxonomyToOccurrence.mjs
 *
 * Given an occurrence (which may carry one or more nucleotide sequences),
 * query vsearch for each sequence, pick the best match per sequence, then
 * compile a single classification that the GBIF pipeline can hand to the
 * taxon-matching service against the default checklist.
 *
 * The returned classification is intentionally shallow — scientificName plus
 * whatever higher-rank fields can be determined — so the taxon-matching service
 * can resolve it to a backbone taxon key. The `remarks` field records enough
 * provenance for an auditor to understand why this classification was chosen.
 *
 * Consumer: GBIF indexing pipeline (_dna_assisted classification field).
 * See: https://github.com/gbif/gbif-dna/issues/2
 */

import { pickBestMatch } from './pickBestMatch.mjs';

/**
 * Main entry point.
 *
 * @param {object} occurrence - A GBIF occurrence object with a `nucleotideSequence`
 *   array (see extractSequences for the expected shape).
 * @param {Function} searchSequences - Async function that accepts a FASTA string
 *   and returns a map of { nucleotideSequenceID → [vsearch match objects] }.
 *   Injected so the caller controls batching, caching (HBase), etc.
 * @returns {Promise<DnaClassification|null>} Classification object, or null if
 *   no sequences are present or no matches were found.
 */
export async function assignTaxonomyToOccurrence(occurrence, searchSequences) {
  // 1. Extract valid nucleotide sequences from the occurrence.
  const sequences = extractSequences(occurrence);

  if (sequences.length === 0) {
    return null;
  }

  // 2. Build a FASTA string from all sequences and send to vsearch.
  const fasta = buildFasta(sequences);
  const allMatches = await searchSequences(fasta);
  // allMatches: { [nucleotideSequenceID]: [match, ...] }

  // 3. For each sequence, pick the top matches (up to 5).
  //    Pass occurrence context (location etc.) so pickBestMatch can use it
  //    for geographic plausibility checks or other context-sensitive ranking.
  const occurrenceContext = extractContext(occurrence);

  const bestMatches = sequences
    .map(({ nucleotideSequenceID }) => {
      const matches = allMatches[nucleotideSequenceID] ?? [];
      const topMatches = pickBestMatch(nucleotideSequenceID, matches, occurrenceContext);
      return { nucleotideSequenceID, topMatches };
    })
    .filter(({ topMatches }) => topMatches.length > 0);

  if (bestMatches.length === 0) {
    return null;
  }

  // 4. Compile a single classification from all best matches.
  //    When the occurrence has multiple sequences (e.g. 16S + COI), they may
  //    agree or conflict. The selection logic lives in compileClassification().
  return compileClassification(bestMatches, occurrence);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract valid nucleotide sequences from an occurrence.
 *
 * Reads from occurrence.nucleotideSequence (array). Each entry has:
 *   - nucleotideSequenceID {string}  MD5 hash identifying the exact sequence variant
 *   - sequence             {string}  the DNA sequence string
 *   - invalid              {boolean} true if the sequence failed QC — skip these
 *
 * Only entries with a non-empty sequence and invalid !== true are included.
 *
 * @param {object} occurrence
 * @returns {{ nucleotideSequenceID: string, sequence: string }[]}
 */
function extractSequences(occurrence) {
  const entries = occurrence.nucleotideSequence;
  if (!Array.isArray(entries) || entries.length === 0) {
    return [];
  }
  return entries
    .filter(entry => entry.sequence && !entry.invalid)
    .map(({ nucleotideSequenceID, sequence }) => ({ nucleotideSequenceID, sequence }));
}

/**
 * Extract occurrence-level context fields to pass to pickBestMatch.
 *
 * These fields are not part of the sequence data but may inform match ranking —
 * for example, geographic coordinates can be used to check whether a proposed
 * species identification is plausible given the collection location.
 *
 * Add further fields here as pickBestMatch's ranking logic evolves.
 *
 * @param {object} occurrence
 * @returns {OccurrenceContext}
 */
function extractContext(occurrence) {
  return {
    decimalLatitude:  occurrence.decimalLatitude  ?? null,
    decimalLongitude: occurrence.decimalLongitude ?? null,
    gbifID:           occurrence.gbifID           ?? null,
  };
}

/**
 * Build a FASTA string from a list of sequences.
 * The sequence ID is used as the FASTA header so vsearch returns results
 * keyed by nucleotideSequenceID.
 *
 * @param {{ nucleotideSequenceID: string, sequence: string }[]} sequences
 * @returns {string}
 */
function buildFasta(sequences) {
  return sequences
    .map(({ nucleotideSequenceID, sequence }) => `>${nucleotideSequenceID}\n${sequence}`)
    .join('\n');
}

/**
 * Compile a single DnaClassification from one or more per-sequence top-match lists.
 *
 * When there is only one sequence, the classification is taken directly from its
 * top match. When there are multiple sequences, a reconciliation strategy is
 * needed — for example, prefer the match with the highest identity, or take the
 * lowest-common-ancestor across all matches.
 *
 * The `remarks` string should capture:
 *   - how many sequences were present and matched
 *   - the reference dataset, target gene, identity, and query coverage for each match
 *   - which reconciliation rule was applied when multiple sequences were present
 *
 * @param {{ nucleotideSequenceID: string, topMatches: object[] }[]} bestMatches
 * @param {object} occurrence - Original occurrence, for provenance context.
 * @returns {DnaClassification}
 */
function compileClassification(bestMatches, occurrence) {
  // Select the sequence whose top match has the highest identity.
  const { nucleotideSequenceID, topMatches } = bestMatches.reduce(
    (a, b) => (b.topMatches[0].identity > a.topMatches[0].identity ? b : a)
  );
  const best = topMatches[0];

  const cls = {
    scientificName: best.scientificName,
    taxonRank:      best.taxonRank,
  };

  for (const rank of ['kingdom', 'phylum', 'class', 'order', 'family', 'genus', 'species']) {
    if (best[rank]) cls[rank] = best[rank];
  }

  const seqCount = bestMatches.length;
  const remarksSeqs = bestMatches
    .map(({ nucleotideSequenceID: id, topMatches: ms }) =>
      `${id}: dataset=${ms[0].dataset} gene=${ms[0].targetGene} identity=${ms[0].identity} qcovs=${ms[0].qcovs}`)
    .join('; ');

  cls.remarks = `${seqCount} sequence(s) matched; selected highest identity (${best.identity}%) ` +
    `from ${best.dataset} (${best.targetGene}, seqID=${nucleotideSequenceID}); ` +
    `all matches: [${remarksSeqs}]`;

  return cls;
}

// ── Types (JSDoc) ─────────────────────────────────────────────────────────────

/**
 * @typedef {object} OccurrenceContext
 * @property {number|null} decimalLatitude
 * @property {number|null} decimalLongitude
 * @property {string|null} gbifID
 */

/**
 * @typedef {object} DnaClassification
 * @property {string}      scientificName  - Name at the identified rank, for taxon matching.
 * @property {string}      taxonRank       - Rank of scientificName (e.g. "SPECIES", "GENUS").
 * @property {string}      [kingdom]
 * @property {string}      [phylum]
 * @property {string}      [class]
 * @property {string}      [order]
 * @property {string}      [family]
 * @property {string}      [genus]
 * @property {string}      [species]
 * @property {string}      remarks         - Provenance: which sequences, references, identity scores,
 *                                           and reconciliation rules led to this classification.
 */
