# Jev trials for headline rating

> **Outcome:** this research became the headline classifier, `src/classifier/` (design, settings and results in [docs/classifier.md](../../docs/classifier.md)), and its tuning tools, `tools/classifier/`. This directory is the record of how it was designed. The scripts here are the research versions; use `tools/classifier/` for real tuning.

Can Jev (`typesafe/jev-1.13` via OpenRouter, see `docs/jev/`) replace or add to the Qwen sampling rater in the Medium digest? This directory holds the trial data, the scripts, and the threshold-tuning plan.

Everything in `data/` is gitignored, so the scripts can't run from a fresh clone. It held headlines from Hermes runs, cached Jev answers (`answers.<profile>.jsonl`) and the maintainer's labels.

## Dataset (2026-10-02)

`data/dataset.json` contains 1,223 unique headlines (title, subtitle, author, publication). They come from the 8 `medium-digest` cron runs between 2026-09-25 and 2026-10-02 (`get_feed` results in Hermes's `state.db`) and from today's two `digest_begin` run files. The weak ("silver") labels on each item are:

| field | meaning | count |
| --- | --- | ---: |
| `sonnet: read_in_full` | Sonnet put it in ⭐ Read in full | 42 |
| `sonnet: listed` | appeared in another digest section | 195 |
| `sonnet: not_picked` | in the feed, not in the digest | 986 |
| `user_read` | in your Medium reading history (as of the runs and today) | 16 in the dataset |
| `qwen_skip` | production Qwen rater's skip confidence (today's run only) | 123 |

**Silver labels are weak.** The older digests listed slop such as "My Medium Stats and Earnings" and "20 Essential Things Every Adult Should Master", and they left out good posts such as a Kafka consumer outage write-up or an Ignite cluster how-to. Use silver labels to compare options with each other, never to set thresholds.

## Options under trial

Every option runs on two input variants: **t** (title only) and **ts** (title, subtitle, author, publication). They are grouped into two request shapes (`questions.mjs`). All questions in a request are answered independently, so bundling only saves resending the input.

| | Option | Jev primitive | What it would do in the digest |
| --- | --- | --- | --- |
| A | Skip gate | 1 Noul with the whole Skip list as criteria | Drop-in replacement for `SamplingRater` (`skip` condition) |
| A′ | Skip gate, reader in state | Same, with interests + skips passed as state | Same as A |
| B | Per-pattern skips | 6 Nouls, one per Skip bullet | Skip if any pattern ≥ its own threshold; also says *which* rule fired, standing in for the `reason` Jev can't give |
| C | Substance | Score, 4 levels from engagement bait to concrete specifics | A slop signal that doesn't depend on the Skip list |
| D | Topic | Choice over your 3 interests + other tech + non-tech | Off-topic filter or grouping |
| E | Importance | Score, 4 levels, with your interests in state | Ranks the shortlist for ⭐ Read in full |
| F | *Snippet (not run yet)* | A or E with the first ~80 words of the post added | Catches good posts with clickbaity titles ("I Gave Claude My Inbox. Seven Things Nobody Warned Me About." got skip 0.92 but was a ⭐ pick) |

Cost of the full run (4,880 requests): **$0.16**, about $0.033 per 1,000 requests and ~0.3 s each. Per daily digest (~150 headlines × 2 requests) that's about a cent.

## First results (silver labels, `node analyze.mjs --examples`)

AUC (0.5 = coin flip) for telling Sonnet's picks apart from posts it didn't pick:

| signal | picked vs not (t / ts) | ⭐ read in full vs not (t / ts) |
| --- | --- | --- |
| A skip | 60 / 62 | 69 / 73 |
| A′ skip, reader in state | 63 / 67 | 67 / 74 |
| B max pattern | 64 / 64 | 72 / 73 |
| C substance | 62 / 64 | 71 / 72 |
| D P(interest topic) | 73 / 73 | 80 / 78 |
| **E importance** | **73 / 74** | **79 / 82** |

- **Use title + subtitle (ts).** It's equal or better in nearly every row and costs about 10% more.
- **E (importance) is the strongest single signal** for "what's worth reading". D (topic) is close behind and doesn't need the reader profile.
- **B (per-pattern) loses fewer good posts than A at the same threshold.** On silver labels at 0.7, A drops 30% of items and 20% of positives; B drops 19% and 8%. Most of those "wrongly dropped positives" are slop the old digest listed, so the real false-skip rate is lower. The gold labels will measure it.
- **Jev and Qwen agree on 102 of 123** skip decisions (A′ at 0.5 vs Qwen at 0.7: 37 both skip, 65 both keep, 21 split).

## Gold results (2026-10-03)

There are 160 hand labels: 63 read, 42 must, 29 meh, 26 skip (`node analyze.mjs --gold`, saved in `data/report-gold.md`). The snippet comparison uses the 159 posts that still exist on Medium.

**As a ranking signal, E (importance) works.** It is the best signal on every label set (AUC 82 for not-slop, 76 for read|must, 79 for must).

| E, title + subtitle | wanted (read or must) | must | skip |
| --- | ---: | ---: | ---: |
| base rate | 65% | 26% | 16% |
| top 10 | 100% | 80% | 0 |
| top 20 | 90% | 50% | 1 |
| bottom 30 | 9 of 30 | 1 | 17 of the 26 |

**As a hard skip gate, nothing meets the rule** (no must dropped, ≤5% of read dropped). The only thresholds with no must dropped are B ≥ 0.9 and A′ ≥ 0.9. Those drop 5–6 posts, catch 3–4 of the 26 slop posts, and still drop 2 read posts. Anything that catches more slop also drops must posts: E < 0.5 catches 21 of 26 but drops 23 read and 5 must.

**The main reason is that the labels don't follow the written Skip list.** Posts labelled read or must included a Medium-ban story, a dropshipping-money post, two life-lesson essays and "10 Modern CLI Tools You Should Try in 2026". Those are all Skip-list patterns that Jev correctly flagged. In the other direction, the Ignite-on-Docker-Compose how-to and the .NET agent-orchestration post were labelled skip even though they fit the Interests list. Per-pattern firing at 0.7: `clickbait` hit 3 skip and 4 read, and `life_lesson` 4 skip and 2 read. A classifier that follows `interests.md` can't match labels that disagree with it. Either update `interests.md`, or accept that headline-level skipping will cost some wanted posts.

**Phase 3, snippet (tss = ts + opening ~80 words, $0.012 for 318 requests).** It gives small, consistent gains: E for not-slop 82.1 → 84.1, C (substance) 75.3 → 78.5, A′ 75.2 → 77.3. B and must-vs-rest stay flat. At E < 0.5 it drops 24 wanted posts instead of 28 and catches the same 21 slop. With 159 items, gains of about 2 AUC are within noise. It also needs one Medium `read_post` per headline (~150 per run, about a minute at a polite rate). **Not worth it yet.** Revisit if a skip gate goes in, since that's where the snippet helped most.

**Recommendation.**
1. Use **E with title + subtitle as a ranking signal**: order the shortlist and propose ⭐ Read-in-full candidates, and drop nothing on Jev's word alone. This matches the "model judges" design: Sonnet or Qwen still decides, but starts from a better-ordered list.
2. If any skipping stays in, use **B ≥ 0.9 only** (about 3% of items, mostly slop), or keep the current Qwen gate until `interests.md` is revised and re-labelled.
3. Before tuning a gate again, **revise `interests.md`** to match what you actually label, re-run `run.mjs` on the sample (about $0.02), and re-run `analyze.mjs --gold`. The 160 labels stay valid.
4. Qwen comparison is still open: only 17 labelled items have a production Qwen rating. Running `rate_headings` over the sample on Hermes would close that.

## Interests v2 (2026-10-03)

The profiles live in `data/interests.<v>.md`; pick one with `PROFILE=v2` for `run.mjs` and `analyze.mjs`. Answers are cached per profile in `data/answers.<v>.jsonl`. Changes in v2, from the user's review of their labels:

- Removed "N best / Top N" and "clickbait framing" as skip patterns. A note in the Skip section says a catchy or numbered title alone isn't a reason to skip.
- "I tried N …" stays, clarified as a tally of things sampled rather than one thing explored in depth.
- Money moved to a new Interest ("side businesses and investing … from someone showing real numbers, decisions or experience"). The skip bullet is now limited to hustle-bro posts (get-rich promises, income screenshots, guru advice with no track record).

**Results** (159 labelled posts, title + subtitle, $0.024): the skip gates improved a lot, and ranking stayed the same.

| | v1 | v2 |
| --- | --- | --- |
| A′ (skip, reader in state), AUC for not-slop / wanted | 75 / 71 | 81 / 78 |
| A′ ≥ 0.7: dropped, slop caught, read lost, must lost | 33, 12, 12, 4 | 12, 7, 3, **0** |
| A′ ≥ 0.6 | 54, 17, 20, 5 | 20, 12, 4, **0** |
| E importance, AUC for not-slop / wanted | 82 / 76 | 81 / 76 |

**A′ ≥ 0.7 is the first gate that meets the rule** (no must dropped, ≤5% of read dropped: 3 of 63). The snippet still adds nothing that matters.

**Money posts.** There are only 12 money-related posts in the sample (4 skip, 2 meh, 5 read, 1 must). v2 keeps the wanted ones that v1 dropped (dropshipping, the Atlassian layoff post). The hustle-bro pattern barely fires: its maximum is 0.43, on "I'm Here to Grab All Your Medium Money", even with the snippet. Headlines and openings don't separate hustle-bros from real operators, and the category isn't noisy enough in this feed to need it.

**Slop that gets through is mostly general self-help and pop psychology** ("The Psychology of Letting Go", "Why You're Always Tired…", "Joining a Run Club will CHANGE Your LIFE!"), plus sports and health. These get importance < 0.2. But the user also labelled similar posts as read ("This is Feynman's Thinking Habit", "I Moved to France…"), so a skip bullet for them would cost wanted posts. Ranking handles them better than skipping. Three posts labelled skip are on-topic tech (Ignite cluster, .NET orchestration, "How I Build AI Projects"), which no profile will catch from the headline.

## Rater benchmark (ranking), 2026-10-03

`bench.mjs` scores the 160 labelled headlines with one backend and saves the result to `data/bench/`. `bench-report.mjs` compares every saved run on the same labels, using graded gains (skip 0, meh 1, read 2, must 3), and adds speed and cost. Backends:

- **`jev`**: reads the answers `run.mjs` cached (importance score, profile v2, title + subtitle).
- **`sampling`**: the production `SamplingRater` from `dist/classifier/sampling.js` against any OpenAI-compatible chat endpoint, with thinking off. It's given the production `skip` condition plus a `want` condition phrased like Jev's importance question, and ranks by `want`.
- **`embed`**: embedding similarity (closest Interest bullet minus closest Skip bullet). Written but **not run yet**: the user asked to compare only the Qwen already in use.

To add a Jev alternative, write one function returning `{ ratings: { id: { score } } }`.

Ollama on `dtop.home` (the Windows side) isn't reachable from WSL. Tunnel through the Hermes host with `ssh -f -N -L 11435:dtop.home:11434 core@192.168.50.207`; `--base` defaults to `http://localhost:11435/v1`.

**Results, profile v2:**

| backend | AUC wanted | AUC not-slop | NDCG@20 | top 10 wanted | top 20 must | slop in bottom 30 | s per 100 headlines | $ per 100 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Jev 1.13 | 76.4 | 80.9 | **72.2** | **100%** | **55%** | 14/26 | **1.9** | 0.003 |
| Qwen 3.6 27B (production rater) | 75.2 | 78.8 | 62.8 | 70% | 40% | 14/26 | 111 | 0 |

Base rates: 66% wanted, 26% must; a random order puts about 5 slop posts in the bottom 30.

- **They mostly agree on order** (Spearman 0.91) and are about equal at the bottom: both put 14 of the 26 slop posts in the bottom 30.
- **Jev is better at the top**, which is where ⭐ picks come from. Qwen's confidences are coarse (10 distinct values, 46 posts at 0.9), so its top 10–20 is mostly ties.
- **Speed:** Qwen took 178 s for 160 headlines (4 batches of 40). A real run has ~120–200 headlines, so that's 2–4 minutes of GPU time per digest, against about 3 s for Jev. Qwen was already loaded and nothing else got swapped in, so there was no GPU thrashing; the cost is time, not swapping.

## Threshold-tuning plan (as carried out)

Phases 1–3 were done as written (results above). Phase 4 became the shipped classifier instead of a `TitleRater` shadow run: `src/classifier/jev.ts` ranks and skips in `digest_begin`, and `tools/classifier/` is the repeatable version of phases 1–2.

**Phase 1 — gold labels (you, about 10 minutes).**
`node label.mjs` shows 160 headlines one at a time (title, subtitle, author), with no scores shown. Press 1 skip (slop / never want), 2 meh, 3 read, 4 must. It's resumable, and `u` undoes. The sample (`data/sample.json`) is stratified: 40 of Sonnet's ⭐ picks and your own reads, 21 from each fifth of A's skip probability, and the 15 not-picked posts E rated highest. That way the region where thresholds matter is covered.

**Phase 2 — pick options and thresholds (`node analyze.mjs --gold`, no API cost).**
1. **Skip gate (A / A′ / B).** The costly error is dropping a post you'd label *read* or *must*. Choose the **lowest threshold where no `must` and at most ~5% of `read` posts are dropped**, then read off how much slop it catches. For B, set each pattern's threshold separately. A pattern that can't reach that precision at any threshold means fix its wording (as the cookbook found with `celebrity`), not just raise the threshold.
2. **Ranking (E, C×D).** Use AUC and precision@10 for `read|must`. Keep E if it beats D alone by a clear margin. Otherwise D is simpler and doesn't depend on the reader profile.
3. **Compare with Qwen.** Run the same metrics on whichever labelled items have a `qwen_skip`. To widen that overlap, run `rate_headings` (always registered, read-only) over the sample; that's cheap but slow (~27 s per 40).
4. Save the chosen thresholds, the precision/recall table and the label counts to `data/thresholds.json` and a short note here.

**Phase 3 — snippet arm (F), only if Phase 2 shows clickbait-titled good posts being dropped.**
Fetch the first ~80 words of the 160 sampled posts once with `read_post` (Medium API; 160 calls, cached), add `snippet` to the state, and re-run A and E on just those. Keep F only if it raises recall of `read|must` at the same skip rate.

**Phase 4 — shadow run in production.**
Add a `JevRater` behind `TitleRater`, enabled when `OPENROUTER_API_KEY` is set, and pin `typesafe/jev-1.13` so thresholds stay valid. For a week, run it *alongside* Qwen and log both verdicts in `runs/<id>.json` while Qwen still decides. Every few days, label ~30 new headlines where the two disagree. Switch over if Jev's false-skip rate is at or below Qwen's. This also removes the 120 s+ Qwen batch latency from `digest_begin`.

**Re-tune when:** `interests.md` changes, or the pinned Jev version changes. `tools/classifier/score.mjs` caches scores per version of `interests.md`, so a changed file gets fresh scores automatically.

## Scripts

```sh
cd experiments/jev
PROFILE=v2 node --env-file=../../.env run.mjs [--shape r1,r2] [--variant t,ts,tss] [--sample]   # calls Jev, caches to data/answers.<profile>.jsonl
PROFILE=v2 node analyze.mjs [--gold] [--examples]                                                # metrics; no API calls
node label.mjs                                                                                    # hand labels → data/labels.jsonl
node snippets.mjs                                                                                 # opening ~80 words per sampled post (Medium API)
node bench.mjs jev | sampling --model … | embed --model …; node bench-report.mjs                 # backend benchmark
```

Rebuilding `data/dataset.json` from Hermes took a one-off extraction: the `get_feed` and `get_reading_history` tool results for `cron_683b98ca11eb_*` sessions in `/opt/data/state.db`, the digest messages for picks, and `runs/*.json` for Qwen ratings. Two of the 59 feed results were too large and were saved to `/tmp` in the container (since cleared), so they're missing.
