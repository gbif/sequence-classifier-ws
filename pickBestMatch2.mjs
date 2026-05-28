/**
 * Select the single best vsearch match for a query sequence.
 *
 * @param {string} queryId - The nucleotideSequenceID of the query.
 * @param {object[]} matches - Ranked list of vsearch match objects.
 * @param {import('./assignTaxonomyToOccurrence.mjs').OccurrenceContext} [context]
 *   Optional occurrence-level context (location, gbifID) for context-sensitive
 *   ranking — e.g. geographic plausibility of a proposed species identification.
 * @returns {object|null}
 */
export function pickBestMatch2(queryId, matches, context) {
  // TODO: implement ranking logic using identity, query coverage, reference
  // dataset priority, and optionally occurrence context (e.g. coordinates).
  return matches[1] ?? null;
}
