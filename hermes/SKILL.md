---
name: medium-digest
description: Daily Medium digest in three sections (the Following feed, Medium's top picks, and personal "For you" recommendations), with picks read in full by subagents. Uses the medium-reader MCP server.
version: 1.2.0
platforms: [linux]
metadata:
  hermes:
    tags: [medium, reading, digest]
    category: productivity
---

# Medium Digest

## Settings
Edit these for your setup. The rest of this skill refers to them by name.

- `STATE_DIR`: `/opt/hermes-sandbox/medium_digest`. Where the state and interests files live. It must be writable by the agent: if `HERMES_WRITE_SAFE_ROOT` is set, it has to be inside it.
- `TIMEZONE`: `UTC`. An IANA name such as `America/Denver` or `Europe/Berlin`, used only to show the "since" time in the header.
- `MAX_PARALLEL`: `2`. How many tasks one `delegate_task` call may run at once. Use your Hermes delegation concurrency limit.
- `REAUTH`: "Run `node dist/cli.js login` in medium-reader-mcp on a machine with a browser, then copy the new `auth.json` into the directory `MEDIUM_READER_HOME` points to on the Hermes host." This is the message sent when the session has expired.

## When to Use
Scheduled (cron) or on request: "what's new on Medium", "Medium digest", "anything worth reading on Medium?".

## Tools
- The medium-reader MCP tools: `auth_status`, `get_feed`, `read_post`, `get_reading_history`. They may be listed with an `mcp_medium_reader_` prefix.
- `delegate_task` to read posts in batches. Subagents inherit the medium-reader tools.
- `read_file` / `write_file` / `patch` for state. Only write inside `STATE_DIR`.
- Don't use `terminal` or `execute_code`, and don't invoke `hermes` as a shell command. They're blocked in cron runs anyway.
- **Keep every tool result under 50,000 characters.** Anything bigger is saved to a file you can't parse. That's why every `get_feed` call below uses `limit` 50 or less. If a result does come back as a saved file anyway, don't try to parse it: repeat the call with a smaller `limit` (25).
- Write no files except `state.json`.

## How Medium's feeds work (why the digest is shaped like this)
- **Following** (`get_feed`, `feed: "following"`) is every post from the authors and publications the user follows, roughly newest first, about 60–75 a day. Reading everything isn't practical, so you shortlist and read ~10.
- **For you** (`get_feed`, `feed: "for_you"`) is a ranked list of about 1,000 posts that Medium builds and keeps serving.
  - **Positions 0–25** are Medium's picks: popular posts, often weeks old, with high clap counts, spread across the user's topics.
  - **Positions 25–250** are the most personal part: the most posts from authors the user follows or has read.
  - Each post's `reason` says why it's there ("Because you follow Coding", "Based on your reading history", "From your network", "<name> clapped").
- **Never page "For you" past position 250.** Paging to the end of the list makes Medium build a new one, which replaces the user's homepage. In this skill "For you" is only ever read with the calls in step 3.

## State
Medium has no read flag, so "new" means **not yet reported by this digest**.

State file: `STATE_DIR/state.json`, **pretty-printed with `indent=2`**:

```json
{
  "last_run": "2026-09-26T12:15:00Z",
  "reported_posts": [
    "b7ea04132470"
  ]
}
```

- `reported_posts` holds **post ids** (the 12-character hex `id` field). Every post that appears anywhere in a digest goes in here, from any section. The same post can come up in Following and in For you, and on several days in a row.
- If the file is missing or unreadable, treat it as the first run: `last_run` = 24 hours ago, and `reported_posts` is empty.
- Keep only the most recent 3000 ids.
- Write the file **only after** the digest is complete, so a failed run is picked up next time.
- `last_run` is always the run's **start** time. On cron runs, copy `RUN_STARTED_AT` from the script output at the top of the prompt, exactly. When run by hand without that line, note the current UTC time before step 1 and use that.

Interests file: `STATE_DIR/interests.md`. The user maintains it. Read it if it exists and use it, together with anything you remember about the user, when ranking. Its **"Skip"** section lists title patterns the user never wants to see (the slop filter in step 4).

## Procedure

### 1. Auth
Call `auth_status`. If the session is missing or rejected, stop and send only:
"📰 Medium digest skipped — session expired. <REAUTH>"
If it says the account isn't a member, carry on, but mark picks as preview-only where `read_post` says so.

### 2. Collect
**a. Following.** Call `get_feed` with `feed: "following"`, `since` = `last_run`, `limit: 50`. If it returns `nextCursor`, call again with `cursor`, the same `since` and `limit: 50` until there's no `nextCursor`. Expect 1–3 calls. Drop posts whose `id` is in `reported_posts`. This is the **Following pool**.

**b. Authors the user reads.** Call `get_reading_history` with `limit: 45`. Note the `authorUsername` and `publication` values. They're only for ranking, and they don't appear in the digest.

### 3. Collect For you
- Call `get_feed` with `feed: "for_you"`, `limit: 25`. These are positions 0–25: the **Top picks pool**.
- Call `get_feed` with `feed: "for_you"`, `limit: 50`, `cursor` = the `nextCursor` from that call (positions 25–75), then once more with `limit: 25` and the new `nextCursor` (positions 75–100). Together these are the **For you pool**.
- Drop posts whose `id` is in `reported_posts`, or that are already in the Following pool.
- If fewer than 20 posts remain in the For you pool, make **one** more call with `limit: 50` and the latest `nextCursor` (positions 100–150) and add those. Never go further.

### 4. Slop filter, then shortlist (main session, from metadata only)
First, go through every post in all three pools and set aside any whose title matches the "Skip" section of `interests.md`, or the built-in list below. Match the **pattern and intent**, not exact words: "I Tried 20+ C++ Courses on Udemy" matches "I tried N …". Skipped posts are never shortlisted and never listed. Count them, and note their authors.

Built-in skip patterns, which apply even without `interests.md`:
- Course, book and tool roundups: "I tried N+ …", "N best …", "Top N …", "N tools/courses/books you must …"
- Money and hustle: "$X/month", "I made $…", "passive income", "side hustle", "quit my job"
- Writing about writing on Medium: "my Medium earnings", "my Medium account", "N followers"
- Bait framing: "Nobody tells you …", "… will change your life", "You're using X wrong", "Stop using X", "… is dead", "This one trick …"

Then rank what's left.
Rank from `title`, `subtitle`, `author`, `publication`, `readingMinutes`, `claps`, `memberOnly`, `reason`, the authors and publications the user reads (step 2b), and the user's interests.
- **Following:** pick up to **10**. Rank up authors and publications the user reads, and substantive topics. Rank down listicles, "I made $X", "N tools you must know", and near-duplicate headlines. Take at most 3 per publication.
- **Top picks:** pick up to **5** from the Top picks pool.
- **For you:** pick up to **10** from the For you pool. Rank up "Based on your reading history" and authors the user reads.
- If a pool is weak, pick fewer. Don't pad.

### 5. Read the shortlist, in batches of subagents
Split all shortlisted posts into chunks of **5**. Call `delegate_task` with `tasks=[…]` of **at most `MAX_PARALLEL` tasks per call**, and keep calling it until every chunk is done.

Give each task this goal, with its 5 posts (url, title, section) listed in the context:

> Read each of these Medium posts in full with `read_post` (`format: "text"`, `max_chars: 40000`). If the response says to call again with `start`, do so until you reach the end. Don't skim, and don't summarize from the title. For each post, return exactly this block and nothing else:
>
> ```
> ID: <12-char hex id from the url>
> URL: <url>
> TITLE: <title> | BY: <author> | PUB: <publication or "-"> | ACCESS: full | preview-only
> TYPE: essay | reporting | analysis | tutorial | listicle | opinion | announcement | other
> GIST: <2–3 sentences: the actual argument or findings, not the topic>
> DEPTH: <1–5, how much is lost by reading only the gist: 5 = dense original thinking or evidence that doesn't compress; 1 = the gist covers it>
> WHY: <one sentence justifying DEPTH, naming what's distinctive>
> ```
>
> "Only a preview was returned" in the response means ACCESS is preview-only. If `read_post` fails for a post, return its block with `GIST: (could not read: <error>)` and `DEPTH: 0`.

Rules:
- If a chunk comes back missing posts or with errors, retry **that chunk once** in the next `delegate_task` call. After that, keep whatever blocks came back.
- Don't read posts yourself in the main session.

### 6. Choose ⭐ picks
From all the blocks, mark **"Read in full"** picks (⭐): DEPTH 4–5, ranked up for the user's interests and authors they read. Rank down listicles and announcements whatever their DEPTH. Usually 3–6 across all sections. If nothing is strong, say so rather than padding.

### 7. Send the digest
Format it for Discord. Keep each line short.

```
📰 **Medium** — <F> new in Following, <R> read in full (since <last_run in TIMEZONE>)

⭐ **Read in full**
1. **<Title>** — <Author>, <Publication> [member] (preview only)
   <GIST, trimmed to 1–2 sentences>
   _Why:_ <WHY>
   <url>

👥 **Following**
• **<Title>** — <Author> · <one-line gist> <url>
_Also new_
**<Publication>** (<n>) · [<Title>](<<url>>) · [<Title>](<<url>>) · [<Title>](<<url>>) +<k>
**<Publication>** (<n>) · [<Title>](<<url>>) +<k>

🔥 **Medium's top picks**
• **<Title>** — <Author> · <one-line gist> · _<reason>_ <url>

🎯 **For you**
• **<Title>** — <Author> · <one-line gist> · _<reason>_ <url>
```

- Convert `last_run` to `TIMEZONE` carefully for the header, allowing for daylight saving. For example, `2026-09-25T02:40:30Z` in America/Denver (UTC−6 in summer) is **Sep 24**, 8:40 PM MDT, which is the previous day. `<F>` is the size of the whole Following pool.
- ⭐ picks appear only in ⭐, not again in their section. Every other read post appears once in its section.
- **"Also new"** covers the unread, unskipped rest of the Following pool: **one line per publication**, largest first (authors outside a publication go on one "Authors" line). Up to 3 titles per line, each a Discord masked link `[Title](<url>)`. The angle brackets stop Discord embedding a preview for every link. End the line with `+k` when there are more. Leave the section out if nothing's left over.
- End the message with `🗑 Skipped <n> as clickbait` and, if any author accounts for 3 or more of them, `(mostly <author>, <author>)`. Leave it out when nothing was skipped.
- Mark `[member]` for member-only posts. Add `(preview only)` only when ACCESS is preview-only.
- List posts that couldn't be read under "⚠ Couldn't read" at the end, with their URLs.
- If every pool is empty, answer `[SILENT]`. Still update `last_run` first.

### 8. Update state
Write `state.json`, pretty-printed with `indent=2`. Set `last_run` to the run's start time (`RUN_STARTED_AT`), copied exactly. Set `reported_posts` to the previous list plus the id of **every post named anywhere in the digest**, including the "Also new" titles and **every post in the Following pool, even ones not named**, trimmed to the newest 3000. Copy the existing entries exactly as read; don't retype them from memory. If the write fails twice, stop trying and add "⚠ state not saved; the next digest may repeat posts" to the end of the message.

## Pitfalls
- Never call `follow`, `unfollow`, `mute`, `unmute`, `clap`, `undo_clap`, `save_to_list` or `remove_from_list`. This skill only reads.
- Never page "For you" beyond the calls in step 3 (see "How Medium's feeds work").
- `memberOnly: true` describes the post, not the user's access (`auth_status` says whether the account is a member). Take access from `read_post`'s "Only a preview was returned" note.
- Reading through the API doesn't add posts to the user's Medium reading history. That's expected.
- Your final message is the digest (or `[SILENT]`) and nothing else. Don't end the run with a status line like "reading batch 3 now". If the digest isn't finished, keep working.

## Verification
- Every URL and id in the digest came from a tool result.
- Nothing in the digest matches a skip pattern.
- No post appears twice in the digest.
- `state.json` has a newer `last_run`, and it contains every id in this digest.
