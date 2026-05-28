/**
 * Select the top vsearch matches for a query sequence.
 *
 * @param {string} queryId - The nucleotideSequenceID of the query.
 * @param {object[]} matches - Ranked list of vsearch match objects.
 * @param {import('./assignTaxonomyToOccurrence.mjs').OccurrenceContext} [context]
 *   Optional occurrence-level context (location, gbifID) for context-sensitive
 *   ranking — e.g. geographic plausibility of a proposed species identification.
 * @param {number} [topN=5] - Maximum number of matches to return.
 * @returns {object[]} Up to topN matches, best first. Empty array if no matches.
 */
export function pickBestMatch(queryId, matches, context, topN = 5) {
  return [...matches]
    .sort((a, b) => (b.identity - a.identity) || (b.qcovs - a.qcovs))
    .slice(0, topN);
}
