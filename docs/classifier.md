# The headline classifier

The digest has three jobs: decide which posts matter to you, read the ones that do, and present them. The first job is the heart of it. It's where your taste lives, and it runs on every headline, hundreds a day, before any model reads a single post. So it's its own component, `src/classifier/`, with one interface, swappable backends and its own evaluation loop. Summarizing and presenting stay with the agent's model and `digest_finish`.

The classifier is optional. Without it the digest still works; the agent's model just has to sort a longer, unranked list.

```
digest_begin ──► classifier ──► work list, best first ──► agent shortlists ──► subagents read ──► digest_finish
                 (rank + skip,                (low ranks
                  per headline)                collapsed)
```

## What it does

For every new headline (title, subtitle, author, publication) and your `interests.md`, a classifier returns:

- **rank**, 0–1: how much you'd want to read it. `digest_begin` sorts each section of the work list by rank, best first, and shows it as a 0–100 column. When the list is too long for one tool result, the lowest-ranked rows are the ones cut. With `MEDIUM_READER_DIGEST_RANK_FLOOR` set, posts below the floor are listed in one compact line instead of full rows. They're still valid refs, and Following posts among them still appear under "Also new".
- **skip**, 0–1: the probability that it matches one of your Skip patterns. Posts at or above `MEDIUM_READER_DIGEST_SKIP_THRESHOLD` (default 0.7) never reach the agent and are counted in the digest's 🗑 line.

Ranking matters more than skipping. A post ranked low is effectively filtered: the agent starts from the top and rarely gets that far. And ranking can't lose a good post outright, while a skip threshold can.

## Backends

| | `jev` | `sampling` (default) |
| --- | --- | --- |
| What | [Jev](jev/README.md), TypeSafe's decision model, through OpenRouter's Decisions API | The MCP client's own model, through MCP sampling (Hermes: `auxiliary.mcp` or `mcp_servers.<name>.sampling.model`) |
| Ranks | yes (calibrated scale) | no: skip only |
| Speed | ~2 s per 100 headlines (8 parallel requests) | ~110 s per 100 with a local 27B model, batches of 40 |
| Cost | ~$0.003 per 100 headlines (input tokens only) | free, but occupies the client's model |
| Needs | `OPENROUTER_API_KEY` | a client that supports sampling |
| If it fails | nothing is skipped or ranked; `digest_begin` says why | same |

Choose with `MEDIUM_READER_CLASSIFIER=jev | sampling | off`. `jev` without a key falls back to `sampling` and says so in the work list's warnings. Pin the Jev version with `MEDIUM_READER_JEV_MODEL` (default `typesafe/jev-1.13`): thresholds are tuned against a specific version.

Jev gets one request per headline. It judges one input against several questions, so headlines can't be batched into one prompt. The request carries your Interests and Skip bullets plus the headline, and asks two questions:

- `importance`: a 4-level Score from "not for this reader" to "must read". Its probability-weighted position becomes the rank.
- `skip_ctx`: a yes/no ("should this be dropped because it matches one of the reader's skips?"). Its probability becomes the skip.

That shape won a comparison of six question designs; see [Evidence](#evidence).

### Setup with Hermes

```yaml
mcp_servers:
  medium-reader:
    env:
      MEDIUM_READER_DIGEST_DIR: /opt/data/sandbox/medium_digest
      MEDIUM_READER_CLASSIFIER: jev
      OPENROUTER_API_KEY: sk-or-…
      # MEDIUM_READER_DIGEST_SKIP_THRESHOLD: 0.7   # from analyze.mjs
      # MEDIUM_READER_DIGEST_RANK_FLOOR: 0.1       # only if analyze.mjs recommends one
```

`digest_status` shows the classifier in use, and each run's status line looks like `Classifier jev (typesafe/jev-1.13): 118 ranked · 6 skipped (threshold 70%)`.

## Settings

All settings are environment variables on the MCP server (in Hermes: `mcp_servers.<name>.env` in `config.yaml`).

| Variable | Default | What it does |
| --- | --- | --- |
| `MEDIUM_READER_CLASSIFIER` | `sampling` | `jev`, `sampling` or `off`. Default: the Qwen/sampling rater, skip only. |
| `OPENROUTER_API_KEY` | none | Required for `jev`. Without it, `jev` falls back to `sampling` and says so in the work list's warnings. |
| `MEDIUM_READER_JEV_MODEL` | `typesafe/jev-1.13` | The Jev version. Pin one: thresholds are tuned against a specific version. |
| `MEDIUM_READER_DIGEST_SKIP_THRESHOLD` | `0.7` | Posts with a skip probability at or above this are dropped. `1` effectively turns skipping off. |
| `MEDIUM_READER_DIGEST_RANK_FLOOR` | `0` (off) | Posts ranked below this are listed apart (see above). Only with a ranking backend. |

`analyze.mjs` recommends values for the last two from your own labels.

## Tuning it to you

Your `interests.md` is the whole profile, and the only way to know whether it says what you mean is to check it against your own judgments. `tools/classifier/` has four scripts for that loop. They score with the built server's own classifier code, so what you measure is what the digest runs.

```bash
npm run build                                            # the tools use dist/
export MEDIUM_READER_DIGEST_DIR=/path/to/medium_digest   # or pass --digest-dir / --data / --interests

node tools/classifier/collect.mjs                        # 1. add headlines from the digest's run files
node --env-file=.env tools/classifier/score.mjs --all    # 2. score them (so the sample can cover the rank range)
node tools/classifier/label.mjs                          # 3. label ~150 headlines, one keypress each
node --env-file=.env tools/classifier/score.mjs          # 4. score anything new
node tools/classifier/analyze.mjs                        # 5. compare, get recommended settings
```

1. **Collect.** `digest_begin` saves every headline it considered in `runs/<id>.json`, but only the newest 14 are kept. Run `collect.mjs` every week or two to build up `classifier/dataset.jsonl` in the digest directory. If the digest runs on another machine (Hermes in Docker, say), copy its `runs/` directory and use `--runs <copy> --data <dir>`.
2. **Label.** `label.mjs` shows one headline at a time, with no scores, so they can't bias you:
   - **1 skip**: slop, never want it
   - **2 meh**: fine, wouldn't open
   - **3 read**: would open
   - **4 must**: would be annoyed to miss

   It's resumable, and `u` undoes. Label what you'd actually do, not what your `interests.md` says. The gap between the two is what this finds. Around 150 labels take about 10 minutes. Aim for at least 10 each of skip and must, and use `--add 50` for more. If the dataset has been scored, the sample is spread evenly across the rank range, so the thresholds get tested where they matter.
3. **Score.** `score.mjs` uses `--classifier jev` by default; `--classifier sampling --base <OpenAI-compatible URL> --model <name>` measures a local model the same way. Scores are cached per backend and per version of `interests.md` (by hash), so re-running is cheap, and an edited `interests.md` gets a fresh cache next to the old one.
4. **Analyze.** `analyze.mjs` prints, for every scored backend and profile version:
   - **ranking quality**: AUC, NDCG@20, how many of the top 10 you wanted, how much slop sinks to the bottom 30.
   - **a skip-threshold sweep and a rank-floor sweep**, with recommended values. The rule is the lowest skip threshold, and the highest floor, that loses no *must* and at most 5% of *read* (`--max-read-loss`).
   - **where you and the classifier disagree most**: wanted posts ranked lowest, skip posts ranked highest.
5. **Edit `interests.md`, then score and analyze again.** The disagreements say what to change: add the topic you kept wanting, narrow a Skip pattern that catches posts you like, or drop one that's really about title style. Both profile versions stay in the table, so you can see whether the edit helped.

Labels, scores and the dataset are yours. They hold the headlines of posts in your feeds, so keep them out of version control (`classifier-data/` is gitignored).

## Evidence

From the maintainer's account, October 2026: 1,223 headlines from 8 digest runs, 160 hand labels (63 read, 42 must, 29 meh, 26 skip). Full method and numbers are in [`experiments/jev/README.md`](../experiments/jev/README.md).

- **Ranking, Jev vs the production sampling rater** (Qwen 3.6 27B, local), same labels, same profile. Both separate wanted posts about equally (AUC 76 vs 75) and sink the same slop (14 of 26 in the bottom 30, where chance gives about 5). Jev is much better at the top, where ⭐ picks come from: NDCG@20 72 vs 63, top 10 all wanted vs 7 of 10. Qwen's confidences are coarse (10 distinct values), so its top is mostly ties. Jev took 3 s for 160 headlines; Qwen took 178 s.
- **Jev's ranking vs Sonnet's own ⭐ picks** (31 posts): about the same share of musts (48% vs 52%), more wanted (90% vs 77%). Of the 23 musts Sonnet never picked, Jev ranked 18 at 67 or higher.
- **The profile mattered more than the backend.** The first `interests.md` treated title style (listicles, "X is dead", numbers) and all money talk as skips. At a 0.7 threshold it dropped 4 must posts. Rewritten to skip intent rather than style, and with side businesses and investing moved to Interests, the same threshold dropped no must, 3 of 63 read, and 7 of 26 slop. Over the full 1,223 headlines that's 11% dropped instead of 27%, and none of them a past ⭐ pick.
- **Adding the post's first ~80 words** to the input improved AUC by about 2 points, within noise, and costs a Medium request per headline. Not used.
- **Not separable from headlines:** hustle-bro money posts vs real operators by title alone. A separate yes/no for it barely fired. The skip question with the whole profile caught the obvious ones ("If You Want To Make $100 A Day Online…").

## Proposing an interests.md from your activity

You don't have to write `interests.md` from scratch, or guess what's missing from it. Two tools let an agent draft one from what you actually do:

- **`interests_evidence`** (read-only, always available). It gathers your taste signals, marked by how far to trust them:
  - **strong**: reading lists, followed publications, labels marked read or must
  - **medium**: the digest's ⭐ picks
  - **weak**: reading history, which includes clicks you regretted
  - **negative**: labels marked skip, the only basis for Skip bullets

  It returns them with drafting rules learned from the evaluation: skip by intent, not title style; never skip a whole topic you read; include the non-technical topics you read, or they rank last.
- **`save_interests_proposal`** (digest mode). It saves the draft as `interests.proposed.md` and reports which bullets were added and removed. It never touches `interests.md`.

Ask your agent something like "propose a new interests.md from my Medium activity". To draft without an agent, use `tools/classifier/propose.mjs --model <model>`, which works with any OpenAI-compatible endpoint (OpenRouter by default).

**Test the proposal before adopting it.** Draft from half your labels and test on the other half, so the proposal isn't graded on the labels it was written from:

```bash
# agent: interests_evidence with labels: "train"; or:
node --env-file=.env tools/classifier/propose.mjs --model anthropic/claude-sonnet-5.5 --labels train
node --env-file=.env tools/classifier/score.mjs --interests "$MEDIUM_READER_DIGEST_DIR/interests.proposed.md"
node tools/classifier/analyze.mjs --test-half                                                 # both versions, side by side
node tools/classifier/analyze.mjs --test-half --profile "$MEDIUM_READER_DIGEST_DIR/interests.proposed.md"   # its thresholds
```

If it wins, rename it to `interests.md`. On the maintainer's account (October 2026; 75 held-out labels), Sonnet drafted a proposal blind from the training half through `propose.mjs`:

| Profile | AUC wanted | AUC not-slop | NDCG@20 | slop in bottom 30 |
| --- | ---: | ---: | ---: | ---: |
| hand-written original | 81.7 | 91.3 | 68.8 | 9 of 10 |
| hand-revised after the first evaluation | 80.8 | 88.0 | 66.7 | 8 of 10 |
| **drafted from activity** | **84.6** | **93.2** | 64.8 | **10 of 10** |

The drafted file added the topics the labels kept wanting (open-source and Linux stories, UI/UX, writing craft, travel and essays). It replaced the title-style skips with intent-based ones. It was slightly weaker at ordering the very top, but better at everything else.

## Adding a backend

Open-source decision models in the Jev mould are appearing, and any of them can slot in. Implement `Classifier` from `src/classifier/types.ts`:

```ts
interface Classifier {
  readonly name: string;   // shown in the status line
  readonly ranks: boolean; // whether verdicts carry `rank`
  classify(items: Headline[], profile: ReaderProfile, opts?: { deadline?: number }): Promise<ClassifyResult>;
}
// ClassifyResult: { verdicts: ({ rank?: 0–1, skip?: 0–1, reason? } | null)[], unavailable?: string, notes: string[] }
```

Then:

1. Add it to `classifierFromEnv` in `src/classifier/index.ts`.
2. Add a `--classifier` option to `tools/classifier/score.mjs`.
3. Score and compare it with `analyze.mjs` against your labels.

Rules every backend follows:

- **Fail open.** Return `unavailable` or null verdicts; never throw a digest run into an error.
- **Respect the deadline.** `digest_begin` passes one, and the whole call must finish well inside Hermes's 300 s tool timeout.
- **Keep the request shape stable**, so scores and thresholds stay comparable.

The classifier code has no Medium-specific imports. substack-reader-mcp has the same component; only `tools/classifier/source.mjs`, which says where run files live and how to read headlines from one, differs.
