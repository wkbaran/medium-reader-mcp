# Jev: notes for the `jev` backend

Jev (`typesafe/jev-1.13`) is the decision model behind the `jev` backend of the headline classifier (`src/classifier/jev.ts`; see [../classifier.md](../classifier.md)). This page is our own summary of what the backend relies on. For anything authoritative, read TypeSafe's and OpenRouter's documentation, linked [below](#sources).

## What it is

Jev doesn't write text. You send it a **state** (any JSON describing the thing to judge) and a set of named **questions**, and it returns a typed answer for each question, with probabilities. Each question is one of three types:

| Type | Asks | Answer |
| --- | --- | --- |
| Choice | Which of these options? | the option, plus a probability for each |
| Score | Where on this ordered scale? | a probability-weighted position on the levels you define |
| Noul | Is this true? | the probability of yes, 0–1 |

Every question in a request sees the same state and is answered independently, so bundling questions only saves resending the state.

## How the `jev` backend uses it

- **One headline per request.** The state is the reader's Interests and Skip bullets plus one headline (title, subtitle, author, publication). Headlines can't be batched into one prompt the way the sampling backend sends 40 titles, so the backend sends one request per headline, 8 at a time, and retries 429, 5xx and budget 402 responses with backoff.
- **Two questions.** `importance` is a four-level Score from "not for this reader" to "must read"; its weighted position becomes the rank. `skip_ctx` is a Noul ("should this be dropped because it matches one of the reader's skips?"); its probability becomes the skip. Jev gives no reasons. This shape won the comparison in medium-reader-mcp's `experiments/jev/`.
- **Cost.** Jev is billed on input tokens only, about $0.04 per million on OpenRouter as of October 2026, so a few hundred headlines a day cost a fraction of a cent. Each response reports its own `usage.cost`.
- **Providers and auth.** The request shape (`model`, `state`, `questions` → `answers`, `usage`) is shared by OpenRouter's Decisions API, OpenRouter's and TypeSafe's System One API (`/v1/systemone`), and any compatible server. So the backend takes an endpoint URL, a bearer token and a model id (`MEDIUM_READER_JEV_URL`, `MEDIUM_READER_JEV_API_KEY`, `MEDIUM_READER_JEV_MODEL`), like an OpenAI-compatible client. The default is OpenRouter with an OpenRouter key; no TypeSafe account or SDK is needed.
- **Thresholds.** Pick them from your own hand-labelled sample (100–200 items is enough), not from round numbers. A Noul near 0.5 means the model is unsure, not that the post is "medium". `tools/classifier/` does this.
- **Version.** Pin `typesafe/jev-1.13` so tuned thresholds stay valid; `~typesafe/jev-latest` moves. The context window is 32k tokens, and English is its main language.
- The Decisions endpoint is under `/api/alpha/`, so expect changes.

## Sources

Read these for the current request schema, prices and guidance:

- OpenRouter: [Jev overview](https://openrouter.ai/docs/guides/community/jev), [first Decisions API call](https://openrouter.ai/docs/guides/community/jev-tutorial), [Decisions API reference](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request), [classification cookbook](https://openrouter.ai/docs/cookbook/evaluate-and-optimize/jev-classification) (the closest to this use: batch labelling, concurrency, choosing thresholds), [TypeSafe SDK with OpenRouter](https://openrouter.ai/docs/guides/community/typesafe-sdk), [model page and pricing](https://openrouter.ai/typesafe/jev-1.13)
- TypeSafe: [primitives](https://docs.typesafe.ai/primitives) ([Choice](https://docs.typesafe.ai/primitives/choice), [Score](https://docs.typesafe.ai/primitives/score), [Noul](https://docs.typesafe.ai/primitives/noul)), [confidence and thresholds](https://docs.typesafe.ai/confidence), [state](https://docs.typesafe.ai/concepts/state), [how to build with System One](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)
