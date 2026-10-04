# The daily digest: details

The README covers setup. This page covers why the digest tools exist, how to customize the digest, and the behaviour worth knowing about.

## Why this server has tools just for agent harnesses

An unattended, scheduled digest is a different job from a person chatting: nobody notices mistakes, every turn costs money, and the run ends when the model sends its last message. So four extra tools (switched on by `MEDIUM_READER_DIGEST_DIR`) take over everything that doesn't need judgment:

- **The model only judges.** Fetching three feeds, paging, deduplication, time zones, the message layout and saving state are code. They come out the same every run and cost no tokens.
- **State can't be lost.** `digest_finish` saves state before it returns the message, so the agent needs no file tools. Before these tools existed, one run sent its digest and never saved, and another spent half its budget on refused file writes.
- **Summaries can't land on the wrong post.** Every post gets a ref (`F3`, `T1`, `Y12`), and subagents read by ref.
- **The expensive model sees less.** The [headline classifier](classifier.md) ranks and filters headlines before the agent's model sees them.
- **Output fits the harness.** Results are compact plain text under 40,000 characters. Hermes wraps MCP results in JSON and diverts anything over about 50,000 characters to a file the model can't read.
- **It's cheaper.** The daily run on Claude Sonnet went from about $2.50 to about $0.40.
- **It's safe for your account.** `digest_begin` never reads "For you" past position 250, which would make Medium rebuild your homepage list ([why](feeds.md)).

## How a run works

[digest-tools.md](digest-tools.md) follows one run step by step, with a diagram, each tool's arguments and real example output.

1. **`digest_begin`** collects everything new since the last run, from Following, Medium's top picks and "For you" positions 25–100. It then:
   - drops posts already reported
   - runs the classifier: skips are dropped and the rest are sorted by rank
   - returns a work list with refs and writes a run file
2. **The agent shortlists** up to 10 Following, 5 top-pick and 10 "For you" posts. Subagents read them with `read_post`, by ref.
3. **`digest_finish`** takes the picks by ref, lays out the Discord message and saves state. The agent replies with that message unchanged.

## Customizing

- **What gets picked:** `interests.md` in the digest directory.
  - `## Interests`: what you want more of. The classifier ranks against it, and the agent sees it.
  - `## Skip`: kinds of post to drop, judged by intent rather than wording. There's no built-in skip list.
  - Check that it says what you mean with the [tuning tools](classifier.md#tuning-it-to-you), or [draft one from your activity](classifier.md#proposing-an-interestsmd-from-your-activity).
- **Shortlist sizes** (10/5/10, chunks of 5 per subagent) are plain instructions in `hermes/SKILL.md`. How much is fetched is set by `digest_begin`'s arguments.
- **Output:** `MEDIUM_READER_DIGEST_STYLE=markdown` drops Discord's `<…>` around links. The layout is in `src/digest/render.ts`.
- **Schedule and delivery:** `hermes cron edit <job-id> --schedule "…"` or `--deliver …`.

## Things to know

- **State:** `state.json` holds `last_run` plus the ids of every reported post (newest 3,000; `MEDIUM_READER_DIGEST_KEEP`).
  - Only `digest_finish` and `mark_reported` write it. Writes take a lock, go through a temp file and a rename, and keep `state.json.bak`.
  - A run that dies before `digest_finish` saves nothing; the next run covers the same period.
  - `last_run` is the server's clock at `digest_begin` and never moves backwards.
- **Repairs:** `digest_status` shows state and recent runs. `mark_reported` adds ids, URLs or refs, and can move `last_run` forward.
- **Run files:** `runs/<run_id>.json` holds every post considered, the classifier's verdicts and, once finished, the picks. The newest 14 are kept, and refs always refer to the latest run.
- **If the classifier fails** (no key, no sampling support, errors or timeouts), nothing is skipped or ranked, and the work list says why. The call stays under about three minutes.
- **Big days:** to stay under 40,000 characters, the tail of "For you", then of Following, is left out of the list (lowest-ranked first when ranked). Left-out Following posts are still saved and listed under "Also new".
- **Posts that can't be read** are listed under ⚠ and saved as reported; they aren't retried.
- **Read-only:** the skill never uses the tools that change your account.
- **Your account:** this uses Medium's undocumented web API with your session. A daily digest is light, read-only use, but if Medium objects, it's your account at risk.
