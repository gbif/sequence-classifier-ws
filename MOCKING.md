# Building a client against `POST /occurrence/classify/batch`

For developing against this service before it is deployed. Everything in
`test-data/responses/` was captured from a **real run** on 2026-10-14 against the live
proxy and the GBIF test vsearch cluster — the classifications are genuine, not invented.

| File | What it is |
|---|---|
| `classify-batch.request.json` | 5 occurrences — the exact request that was sent |
| `classify-batch.response.json` | The exact response that came back |
| `errors.json` | Error-path status codes and bodies |
| `mock-server.mjs` | Stand-in server, serves the captured response |

## In `gbif/pipelines` — use MockWebServer

`com.squareup.okhttp3:mockwebserver` (5.3.2) is already a managed test dependency of the
pipelines parent pom, so there is nothing to add. Copy the two JSON files into
`src/test/resources/` and enqueue the response body.

The snippet below follows the idiom already used in
`livingatlas/pipelines/src/test/java/au/org/ala/util/TestUtils.java` — the legacy
`okhttp3.mockwebserver` package with the classic setters, not the `mockwebserver3` builders.

```java
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import java.nio.charset.StandardCharsets;

MockWebServer server = new MockWebServer();
String body = new String(
    getClass().getResourceAsStream("/classify-batch.response.json").readAllBytes(),
    StandardCharsets.UTF_8);

server.enqueue(new MockResponse()
    .setResponseCode(200)
    .setHeader("Content-Type", "application/json")
    .setBody(body));
server.start();

// point the client at server.url("/").toString(), then:
//   server.takeRequest()  to assert what was actually sent
server.shutdown();
```

A `Dispatcher` is worth it once more than one path or outcome is in play — and it is the only
way to reproduce the **one-entry-per-input-occurrence** contract for arbitrary input, which a
static stub cannot do:

```java
server.setDispatcher(new Dispatcher() {
  @Override public MockResponse dispatch(RecordedRequest request) {
    String path = request.getPath();
    if (path.startsWith("/health")) {
      return new MockResponse().setResponseCode(200)
          .setHeader("Content-Type", "application/json")
          .setBody("{\"status\":\"ok\",\"vsearch\":\"ok\",\"cache\":\"ok\"}");
    }
    if (path.startsWith("/occurrence/classify/batch")) {
      // echo one entry per input gbifID; use the fixture for known ids, null otherwise
      return new MockResponse().setResponseCode(200)
          .setHeader("Content-Type", "application/json")
          .setBody(buildResponseFor(request.getBody().readUtf8()));
    }
    return new MockResponse().setResponseCode(404);
  }
});
```

For the error paths in `errors.json`, return the status and body as given — all of them are
JSON (see gotcha 4).

### Client side

Pipelines calls external services with **Retrofit 3.0.0 / OkHttp 4.12.0** — the same pattern as
the existing interpretation lookups. Worth following rather than hand-rolling, since it brings the
retry and timeout conventions those clients already use; `502` and `504` from this service are
both upstream failures worth retrying.

Also check **`org.gbif.dna:gbif-dna-core`**, already a declared dependency of pipelines — the
response DTOs may belong there, or already exist. **[VERIFY with whoever owns that artifact;
nothing matching was visible in `gbif/gbif-dna` on GitHub.]**

## Without Java — `mock-server.mjs`

```bash
node test-data/responses/mock-server.mjs     # http://localhost:3001
```

Uses only node builtins — no `npm install`. Returns **one entry per input occurrence, in input
order**; gbifIDs from the fixture get their real classification, anything else gets
`classification: null`, as the live service does for an occurrence with no match. Useful for
`curl` probing and for non-Java clients; the MockWebServer route above is the better fit inside
pipelines.

## The contract

**Request:** a JSON array of GBIF occurrence objects. `Content-Type: application/json` is
required. The only fields the service reads are `gbifID` and `nucleotideSequence[]`, each entry
of which needs `nucleotideSequenceID` and `sequence`, and may carry `invalid: true`.

**Response:** `200` with an array of `{ gbifID, classification }`, one per input, same order.

## Five things that will catch you out

**1. `classification` is `null` whenever nothing was assigned.** Three different situations all
produce it, and the response does not distinguish them:
- the occurrence had no sequences (`999000001` in the fixture)
- every sequence was flagged `invalid: true` (`999000002`)
- the sequences were searched and simply did not match (`1413810076` — a real non-match)

**2. Rank keys are OMITTED, not null or empty.** A species-level result has `species`; a
genus-level result has **no `species` key at all**. Compare `1413807310` (species) with
`1413807586` (genus) in the fixture. A non-optional field in a typed client will break.

**3. Values have spaces where the vocabulary has underscores.** The parser converts `_` to
` ` across all reference fields, so you get `dataset: "boldistilled coi"` and
`targetGene: "coi"` — **not** `boldistilled_coi` or `COI`. If you match `targetGene` against
the GBIF target-gene vocabulary it will not match. Normalise first.

**4. There are two distinct 400s, with different messages.** A body that is not valid JSON gives
`{"error":"Malformed JSON in request body"}`; valid JSON of the wrong shape (`{"gbifID":1}`
instead of an array) gives `{"error":"Request body must be an array of occurrence objects"}`.
Both are JSON — distinguish them by the message, not the status. A body over the 10 MB limit
gives `413` with `{"error":"Request body too large","limit":10485760}`.

**5. `remarks` is free text, not structured.** It records which sequences matched, at what
identity and coverage, and which one the classification came from — useful to display or log,
but do not parse it. Example:

```
2 sequence(s) matched; selected highest identity (100%) from boldistilled coi
(coi, seqID=…); all matches: [… identity=98.1 qcovs=68.6; … identity=100 qcovs=100]
```

## Also worth knowing

- **Sequences are deduplicated across the whole batch** before vsearch is called, so a variant
  shared by many occurrences costs one lookup. Larger batches are cheaper per occurrence.
- **Results are cached** by `nucleotideSequenceID`, so a repeated batch returns quickly.
- **An empty array is valid** and returns `200 []`.
- **Body limit is 10 MB** for JSON.
- `504` means vsearch timed out, `502` means it was unreachable — both upstream, both worth a
  retry. These two are transcribed from `index.mjs`, not reproduced live.
- `GET /health` returns `200` with `{status, vsearch, cache}`, or `503` if either dependency is
  down. Useful as a readiness gate in tests.

## Caveat

The service is **not deployed**. Assignments come from the reference library current on
2026-10-14 and will change as the library is rebuilt — treat the *shape* as the contract and the
*names* as illustrative.
