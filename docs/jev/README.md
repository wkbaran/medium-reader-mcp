# Jev reference docs

Local copies of the OpenRouter and TypeSafe pages on Jev (`typesafe/jev-1.13`), the decision model behind the `jev` backend of the headline classifier (`src/classifier/jev.ts`; see [../classifier.md](../classifier.md)). Kept so the request shape and pricing can be checked without going online.

Fetched 2026-10-02 through Firecrawl. Each file's first line gives its source URL. The site's banner, "skip to content" link and AI-assistant footer were removed; nothing else was edited. These are snapshots, so check the live pages before relying on prices or the schema.

## Files

| File | What it covers |
| --- | --- |
| [jev.md](jev.md) | Hub page: what Jev is, the two API surfaces, FAQ |
| [jev-tutorial.md](jev-tutorial.md) | First Decisions API call (curl/TS/Python) and how to read the answers |
| [typesafe-sdk.md](typesafe-sdk.md) | Pointing the TypeSafe SDK at OpenRouter (`/api/v1/systemone`) |
| [decisions-api-reference.md](decisions-api-reference.md) | `POST /api/alpha/decisions` request/response and errors. The scrape didn't expand the nested question schema; the tutorial and primitive pages show it |
| [cookbook-jev-classification.md](cookbook-jev-classification.md) | **Closest to our use case:** batch labeling with Choice + Noul, concurrency and retries, picking thresholds from a labeled sample, cost per 1,000 |
| [typesafe-primitives.md](typesafe-primitives.md) | Choosing between Choice / Noul / Score, writing instructions and criteria |
| [typesafe-noul.md](typesafe-noul.md) | Yes/no questions (probability of yes) |
| [typesafe-score.md](typesafe-score.md) | Ordered scales (probability-weighted position) |
| [typesafe-choice.md](typesafe-choice.md) | Pick one of N options |
| [typesafe-confidence.md](typesafe-confidence.md) | Reading probabilities and confidence, choosing thresholds |
| [typesafe-state.md](typesafe-state.md) | What to put in `state` |
| [typesafe-how-to-build.md](typesafe-how-to-build.md) | Breaking a workflow down into judgments |
| [model-page.md](model-page.md) | Price, context length, latency (top of the model page only) |

## Notes on how the `jev` backend uses it

- **One item per request.** Each request judges one `state` against any number of `questions`, all answered independently. There's no batching items into one prompt the way `SamplingRater` sends 40 titles. Instead, send one request per headline in parallel. The cookbook used 8 workers with no 429s (400 requests in 8.6 s) and retries 429, 5xx and in-flight-budget 402s with `Retry-After` and backoff.
- **Mapping (as shipped).** The headline (title, subtitle, author, publication) and the reader's Interests and Skip bullets go in `state`. Two questions: `importance`, a 4-level `score` whose weighted position becomes the rank; and `skip_ctx`, a `noul` whose probability becomes the skip. Jev gives no reasons. This shape won the comparison in medium-reader-mcp's `experiments/jev/`.
- **Cost.** Billed on input tokens only, $0.042 per 1M (model page, 2026-10-02); output is free. The tutorial's 3-question request was 476 input tokens and cost $0.00002, so a few hundred headlines a day cost a fraction of a cent. Each response has `usage.cost`.
- **Auth.** Needs an OpenRouter API key (`Authorization: Bearer`) and no TypeSafe account. Plain `fetch` to `https://openrouter.ai/api/alpha/decisions` is enough. The TypeSafe SDK isn't needed.
- **Thresholds.** The docs say to pick per-question thresholds from 100–200 hand-labeled items, not round numbers. A Noul near 0.5 means "unsure", not "medium".
- **Version.** Pin `typesafe/jev-1.13` so tuned thresholds stay valid; `~typesafe/jev-latest` moves. The context window is 32k tokens. English is the primary training language.
- The Decisions endpoint is under `/api/alpha/`, so expect changes.
