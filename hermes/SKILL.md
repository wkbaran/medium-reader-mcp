---
name: medium-digest
description: Daily Medium digest in three sections (the Following feed, Medium's top picks, and personal "For you" recommendations), with picks read in full by subagents. Uses the medium-reader MCP server's digest tools.
version: 2.0.0
platforms: [linux]
metadata:
  hermes:
    tags: [medium, reading, digest]
    category: productivity
---

# Medium Digest

## Settings
Edit these for your setup. The rest of this skill refers to them by name.

- `MAX_PARALLEL`: `2`. How many tasks one `delegate_task` call may run at once. Use your Hermes delegation concurrency limit.
- `REAUTH`: "Run `node dist/cli.js login` in medium-reader-mcp on a machine with a browser, then copy the new `auth.json` into the directory `MEDIUM_READER_HOME` points to on the Hermes host." This is the message sent when the session has expired.

Everything else is configured on the medium-reader MCP server (see its README): where state lives (`MEDIUM_READER_DIGEST_DIR`), the time zone for dates (`MEDIUM_READER_DIGEST_TZ`), and the user's `interests.md` in that directory.

## When to Use
Scheduled (cron) or on request: "what's new on Medium", "Medium digest", "anything worth reading on Medium?".

## How it works
The server does everything that isn't judgment: fetching the feeds, paging, dropping posts already reported, dropping clickbait titles (rated by a model against the Skip section of `interests.md`), time zones, laying out the final message, and saving state. You shortlist, have subagents read, pick the best, and hand your picks back. The server's reply contains the finished digest.

## Tools
- medium-reader MCP tools: `digest_begin`, `read_post`, `digest_finish`. They may be listed with an `mcp_medium_reader_` prefix. `digest_status` is only for debugging.
- `delegate_task` to read posts. Subagents inherit the medium-reader tools.
- No file tools. The server owns the state file and reads `interests.md` itself. Don't use `read_file`, `write_file`, `patch`, `terminal` or `execute_code`.
- Call the MCP tools one per `tool_call`. A batch of several calls is rejected and the retry wastes a turn.

## Procedure

### 1. Begin
Call `digest_begin` once, with no arguments.
- If it fails with "Authentication required", stop and reply only: "📰 Medium digest skipped — session expired. <REAUTH>"
- If the result ends with "Nothing new", call `digest_finish` with no arguments and go to step 6.
- If it fails for another reason, call it once more. If that fails too, reply only: "📰 Medium digest failed: <the error>".

The result is a work list. Each post has a ref (`F` = Following, `T` = Medium's top picks, `Y` = For you), then title, author, publication, minutes, claps, flags (`M` member-only, `R` the user has recently read this author or publication) and, for T and Y, why Medium showed it. It also shows the user's interests.

### 2. Shortlist (from the work list only)
- **Following:** up to **10** F refs, at most 3 per publication. Rank up `R` and the user's interests, and substantive topics. Rank down listicles, money talk and near-duplicate headlines.
- **Top picks:** up to **5** T refs.
- **For you:** up to **10** Y refs. Rank up reason `history` and `R`.
- If a pool is weak, pick fewer. Don't pad.
- If you see clear clickbait the rater missed, note its ref for `extra_skipped` and don't shortlist it.

### 3. Read the shortlist with subagents
Split the shortlisted refs into chunks of **5**. Call `delegate_task` with `tasks=[…]` of **at most `MAX_PARALLEL` tasks per call**, and keep calling it until every chunk is done. Give each task this goal, with its refs listed:

> For each ref below, call `read_post` with `url` set to the ref exactly as given (for example `"F3"`) and `format: "text"`. If the response says to call again with `start`, do so until you reach the end. Call one tool per `tool_call`. Don't skim, and don't summarize from the title. For each ref, return exactly this block and nothing else:
>
> ```
> REF: <the ref>
> ACCESS: <the value of the "- Access:" line: full or preview-only>
> TYPE: essay | reporting | analysis | tutorial | listicle | opinion | announcement | other
> GIST: <2–3 sentences: the actual argument or findings, not the topic>
> DEPTH: <1–5, how much is lost by reading only the gist: 5 = dense original thinking or evidence that doesn't compress; 1 = the gist covers it>
> WHY: <one sentence justifying DEPTH, naming what's distinctive>
> ```
>
> If `read_post` fails for a ref, return `REF: <ref>`, `ACCESS: unreadable`, `GIST: (could not read: <error>)` and `DEPTH: 0`.

If a chunk comes back missing refs or with errors, retry **that chunk once** in the next `delegate_task` call. After that, keep whatever came back. Don't read posts yourself in the main session.

### 4. Choose ⭐ picks
From all the blocks, choose the **"Read in full"** picks: DEPTH 4–5, ranked up for the user's interests and authors they read, ranked down for listicles and announcements whatever their DEPTH. Usually 3–6, never more than 8. If nothing is strong, star nothing.

### 5. Finish
Call `digest_finish` once with:
- `starred`: `[{ref, gist, why}]` for the ⭐ picks. `gist` is the GIST trimmed to 1–2 sentences, `why` is the WHY.
- `following`, `top_picks`, `for_you`: `[{ref, gist}]` for every other post that was read, in its section, with a one-line gist.
- `preview_only`: refs whose ACCESS was preview-only.
- `unreadable`: refs that couldn't be read after the retry. They're listed under ⚠ and never retried.
- `extra_skipped`: the clickbait refs from step 2.

The server checks the refs, writes the digest and saves state. If it reports unknown refs, fix only those entries and call it again; never repeat an identical call. A result starting "STATE SAVED: already saved" is fine.

### 6. Reply
Your reply is the text after the `===== DIGEST` line of the `digest_finish` result, copied exactly: it starts with `📰 **Medium**`, or it is exactly `[SILENT]`. Write nothing before it (no "State saved", no ranking notes, no DEPTH scores) and nothing after it. Don't reformat, shorten or add to it. Do any thinking before you call `digest_finish`, not in this message.

## Pitfalls
- Never call `follow`, `unfollow`, `mute`, `unmute`, `clap`, `undo_clap`, `save_to_list` or `remove_from_list`. This skill only reads.
- Don't call `get_feed` or `get_reading_history`; `digest_begin` does all the fetching, and never reads "For you" past position 250 (going further makes Medium rebuild the user's homepage list).
- Call `digest_begin` only once per run. Each call starts a new run, and refs always refer to the latest one.
- `digest_finish` saves state, so call it before your final message. Your final message ends the run.

## Verification
- `digest_status` shows the run as committed, with a newer `last_run`.
- The reply is byte-for-byte the text after the `===== DIGEST` line.
