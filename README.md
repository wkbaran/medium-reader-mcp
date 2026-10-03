<div align="center">

# Medium Reader MCP

**Ask Claude what's new in your Medium feed, and have it read member-only stories for you.**

An MCP server that gives Claude (and any other MCP client) access to your Medium account: your Following and For you feeds, full member-only posts, the authors and publications you follow, search, and your reading lists. It can also follow and unfollow, save posts to lists, and clap. You log in once in a browser window; no API keys or cookie exporting.

![Node 20+](https://img.shields.io/badge/node-20%2B-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-stdio-6E56CF)
![Tools](https://img.shields.io/badge/tools-18%20%2B%204%20digest-informational)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

[Quick start](#quick-start) · [Other clients](#other-mcp-clients) · [Tools](#tools) · [Hermes Agent](#hermes-agent) · [Logging in](#logging-in) · [Privacy and security](#privacy-and-security) · [How Medium's feeds behave](#how-mediums-feeds-behave) · [Troubleshooting](#troubleshooting)

</div>

## What it uses

| What | Where | Needed? |
|---|---|---|
| Your Medium account | [medium.com](https://medium.com) | Yes. A [membership](https://medium.com/membership) is needed to read member-only stories in full |
| Node.js 20+ | [nodejs.org](https://nodejs.org) | Yes |
| MCP SDK, Zod, undici | npm (`@modelcontextprotocol/sdk`, `zod`, `undici`) | Yes, installed by `npm install` |
| Chrome or Edge | Your existing install, driven by `playwright-core` | Optional. Only for the browser login; you can paste cookies instead |

Medium no longer issues API tokens, and its old API never covered reading. This server calls the same GraphQL endpoint Medium's website uses, with your own session, so it can only see what you can see when logged in. No browser runs while you use it; the browser is only for logging in.

Requests to Medium go over HTTP/1.1 through the `undici` package, not Node's built-in `fetch`. Medium's Cloudflare protection returns 403 to Node's HTTP/2 client. Node 26's built-in `fetch` (undici 8) uses HTTP/2 whenever the server offers it, so it would be blocked on every request.

## Quick start

```bash
git clone https://github.com/wkbaran/medium-reader-mcp.git
cd medium-reader-mcp
npm install && npm run build

node dist/cli.js login     # a browser window opens; sign in to Medium as usual
node dist/cli.js install   # registers the server with Claude Code
```

Restart Claude Code (a session that's already running won't pick up new servers), then try:

- *"What's new in my Medium feed today?"*
- *"Summarize that Towards AI post about schema drift."*
- *"What has Andrej Karpathy published on Medium?"*
- *"Which posts in my reading list are about Rust?"*
- *"Which authors I follow post the most but I never read?"*
- *"Save this post to my AI list."* (Claude asks before each change)

### Example

```text
> What has Andrej Karpathy published on Medium?

● medium-reader - get_recent_posts (source: "@karpathy", limit: 3)

  His three most recent Medium posts:
  1. Software 2.0 (Nov 11, 2017): neural networks as a new way of writing software, not just another ML tool
  2. AlphaGo, in context (May 31, 2017): what AlphaGo's win does and doesn't mean for AI
  3. ICML accepted papers institution stats (May 24, 2017): which institutions had the most accepted ICML papers
```

## Other MCP clients

`install` covers Claude Code. For other clients, point them at `dist/cli.js` with an absolute path. Log in with `node dist/cli.js login` first either way.

<details>
<summary><b>Claude Desktop</b></summary>

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "medium-reader": {
      "command": "node",
      "args": ["/absolute/path/to/medium-reader-mcp/dist/cli.js"]
    }
  }
}
```
</details>

<details>
<summary><b>Cursor</b></summary>

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "medium-reader": {
      "command": "node",
      "args": ["/absolute/path/to/medium-reader-mcp/dist/cli.js"]
    }
  }
}
```
</details>

<details>
<summary><b>VS Code</b></summary>

Add to `.vscode/mcp.json` in a workspace, or to your user MCP configuration:

```json
{
  "servers": {
    "medium-reader": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/medium-reader-mcp/dist/cli.js"]
    }
  }
}
```
</details>

<details>
<summary><b>Claude Code, manually</b></summary>

```bash
claude mcp add --scope user medium-reader -- node /absolute/path/to/medium-reader-mcp/dist/cli.js
```
</details>

## Tools

Authors can be given as `@username` or a profile URL; publications by name, slug (`javarevisited`), or URL, including custom domains (`https://pub.towardsai.net`). Posts can be any Medium link, including custom domains, or the post's hex id.

### Reading

| Tool | What it returns |
|---|---|
| `auth_status` | Whether you're logged in, as whom, and whether the account is a Medium member |
| `get_feed` | Your **Following** feed (default) or **For you**, newest first. `since` takes `"7d"`, `"48h"` or a date |
| `read_post` | A full post as Markdown (or `text`). Long posts are paged with `start`. A member-only story you can't access is flagged as a preview |
| `get_recent_posts` | Latest posts from one author or publication, with a cursor for paging back |
| `search_posts` | Keyword search across Medium |
| `list_following` | Authors or publications you follow. `total` is Medium's own count, which can be higher than the list it returns |
| `list_reading_lists` | Your reading list and named lists, with item counts |
| `get_list` | The posts in one of those lists |
| `get_reading_history` | Posts you've read, most recently read first. Medium gives no read date per post. Useful for asking which follows you actually read |
| `rate_headings` | Rates headlines against conditions you define (up to 5, each with a definition), with a confidence and a short reason per condition. Uses your MCP client's own model through sampling, so it only works in clients that support sampling |
| `interests_evidence` | What your own activity says about your taste (reading lists, follows, history, and with the digest on, its picks and your labels), with rules for drafting an `interests.md` from it. See [Proposing an interests.md](docs/classifier.md#proposing-an-interestsmd-from-your-activity) |

### Digest (only when `MEDIUM_READER_DIGEST_DIR` is set)

`save_interests_proposal` saves a drafted `interests.md` as `interests.proposed.md` beside the real one, which it never changes. The digest tools:

Built for scheduled digests run by an agent harness such as [Hermes Agent](#hermes-agent) ([why](#why-this-server-has-tools-just-for-agent-harnesses)). They return plain text.

| Tool | What it does |
|---|---|
| `digest_begin` | Collects what's new since the last digest, drops posts already reported and titles rated as skips, and returns a plain-text work list with refs (`F3`, `T1`, `Y12`). Writes only a run file |
| `digest_finish` | Takes the picks by ref, renders the final message, and saves state. Repeating it for the same run changes nothing; `dry_run` saves nothing |
| `digest_status` | Read-only: `last_run`, how many ids are saved, and the recent runs |
| `mark_reported` | Repair: adds post ids, URLs or refs to the saved state, and optionally moves `last_run` forward |

`read_post` also accepts a ref from the latest digest run, and its header always includes the post's `ID` and `Access` (`full` or `preview-only`).

### Account changes

| Tool | What it does |
|---|---|
| `follow` / `unfollow` | Follow or unfollow an author or publication. An ambiguous name lists the matches instead of guessing |
| `mute` / `unmute` | Hide an author's or publication's posts from your feeds, including an author's posts in publications you follow. Private |
| `save_to_list` / `remove_from_list` | Add a post to, or remove it from, your reading list or a named list |
| `clap` / `undo_clap` | Clap for a post (never past Medium's 50-per-post limit), or take your claps back |

The reading tools are marked read-only. The digest tools other than `digest_status` are marked as writing, but they only write files in the digest directory. The rest are marked as changing your account, so MCP clients ask before running them. `unfollow`, `remove_from_list` and `undo_clap` are also marked destructive. After each change the server checks with Medium and reports what actually happened; doing something that's already done (following someone you follow, saving a saved post) changes nothing.

Follows and claps are visible to the author, and named lists are public. Mutes are private.

## Hermes Agent

[Hermes Agent](https://github.com/NousResearch/hermes-agent) is Nous Research's open-source, self-hosted agent harness: it runs skills on a schedule, hands work to subagents and delivers the results to chat platforms such as Discord. This section is written for Hermes, but it applies to any agent harness that works the same way. Nothing in the digest tools depends on Hermes; only [`hermes/SKILL.md`](hermes/SKILL.md) does.

### Why this server has tools just for agent harnesses

Everything above is a general MCP server that works in any client. A scheduled, unattended digest is a different job from a person asking questions in a chat: there's nobody to notice a mistake, every turn costs money, and the run ends the moment the model sends its last message. So the server has four extra [digest tools](#digest-only-when-medium_reader_digest_dir-is-set), switched on by `MEDIUM_READER_DIGEST_DIR`, that take on everything that doesn't need judgment. Clients that don't set it see the general tools unchanged.

What that buys:

- **The model only judges.** Fetching three feeds, paging, deduplication, time zones, laying out the message and saving state are code. They come out the same on every run and cost no tokens.
- **State can't be lost.** `digest_finish` saves state before it returns the message, so a run that ends as soon as the agent replies has already saved. The agent needs no file tools at all. Before these tools, a run that sent its digest and then stopped never saved state, and another spent half its budget on refused file writes.
- **Summaries can't land on the wrong post.** `digest_begin` gives each post a ref (`F3`, `T1`, `Y12`), and `read_post` and `digest_finish` take those refs. A subagent reads by ref, so each ref fetches the post it names.
- **Clickbait never reaches the expensive model.** `digest_begin` rates titles through MCP sampling, which runs on whatever cheap model the harness provides, and drops the confident skips before the agent sees the list.
- **Output fits the harness.** The tools return compact plain text under 40,000 characters, because Hermes wraps MCP results in JSON and stops passing results over about 50,000 characters to the model.
- **It's much cheaper.** Fewer turns and a smaller context took the daily run on Claude Sonnet from about $2.50 to about $0.40.
- **It's safe for your account.** `digest_begin` never reads "For you" past position 250, which keeps Medium from rebuilding your homepage list. That's a rule an agent could forget; code doesn't.

A general MCP server makes an account readable by any agent. A few tools shaped for how a harness actually runs make both the server and the harness much more effective than either is alone.

### The daily digest

[`hermes/`](hermes/) contains a skill that turns this server into a scheduled Medium digest. Each morning it collects new posts from your Following feed and from "For you", drops clickbait, has subagents read the most promising 20–25 in full, and sends one message with three sections: Following, Medium's top picks (positions 0–25 of "For you") and personal recommendations (positions 25–100). The top posts are flagged ⭐ "Read in full", with a two-line summary and why they're worth reading. The design follows the findings in [How Medium's feeds behave](#how-mediums-feeds-behave).

The server does the mechanical work through four digest tools, so the agent's model only judges what to read and what's worth it:

1. `digest_begin` fetches everything new since the last digest, drops posts it has already reported, and runs the [headline classifier](#headline-classifier) against your `interests.md`: it drops confident skips and, with a ranking backend, sorts what's left best first. It returns a compact plain-text list with a ref per post (`F3`, `T1`, `Y12`) and saves a run file; nothing else is written.
2. The agent shortlists refs, and subagents read them with `read_post`, which accepts the refs.
3. `digest_finish` takes the agent's picks by ref, checks them, lays out the final Discord message, and saves state (every Following post plus every post it named). The agent replies with that message as is.

#### Setup

1. **Build the server** on your machine (`npm ci && npm run build`). Copy `dist/`, `package.json` and `package-lock.json` to a directory the Hermes container can see (for example `$HERMES_HOME/mcp/medium-reader-mcp`, which is `/opt/data/mcp/medium-reader-mcp` inside the official image), and install the runtime dependencies there:
   ```bash
   npm ci --omit=dev --omit=optional
   ```
   Node 20 or later works, including the Node 26 in the Hermes image.
2. **Log in** on a machine with a browser (`node dist/cli.js login`), then copy `~/.config/medium-reader/auth.json` into a directory on the Hermes host, for example `$HERMES_HOME/mcp/medium-reader-home/`. Keep it at owner-only permissions.
3. **Create the digest directory**, writable by the user Hermes runs as, for example `$HERMES_HOME/sandbox/medium_digest`. Copy `hermes/interests.example.md` into it as `interests.md` and edit it (see below). A `state.json` from version 1 of the skill keeps working.
4. **Register the server** in Hermes's `config.yaml`. The digest tools only appear when `MEDIUM_READER_DIGEST_DIR` is set:
   ```yaml
   mcp_servers:
     medium-reader:
       command: node
       args: ["/opt/data/mcp/medium-reader-mcp/dist/cli.js"]
       env:
         MEDIUM_READER_HOME: /opt/data/mcp/medium-reader-home
         MEDIUM_READER_DIGEST_DIR: /opt/data/sandbox/medium_digest
         MEDIUM_READER_DIGEST_TZ: America/Denver
         # MEDIUM_READER_CLASSIFIER: jev     # optional ranking classifier; see "Headline classifier"
         # OPENROUTER_API_KEY: sk-or-…
       sampling:            # the default classifier; Hermes enables sampling by default
         model: <a local model>   # optional: overrides auxiliary.mcp.model for this server
         timeout: 120             # seconds per request; Hermes's default of 30 is short for a local model
   ```
   Sampling requests go to the provider in `auxiliary.mcp` (`provider`, `model`) unless `sampling.model` overrides the model. A cheap local model is enough: it only rates headlines, about 40 per request. With `MEDIUM_READER_CLASSIFIER: jev`, sampling isn't used for the digest.
5. **Install the skill:** copy `hermes/SKILL.md` to `$HERMES_HOME/skills/productivity/medium-digest/SKILL.md`, and `hermes/medium_digest_start.sh` to `$HERMES_HOME/scripts/`. Edit the Settings block at the top of `SKILL.md`: `MAX_PARALLEL` and the `REAUTH` message.
6. **Restart Hermes and schedule it.** Cron times are in the Hermes host's local time. The job needs only the `delegation` and `medium-reader` toolsets; it uses no file tools:
   ```bash
   hermes cron create "0 7 * * *" "Run the medium-digest skill and deliver the digest." \
     --name medium-digest --skill medium-digest --script medium_digest_start.sh --deliver discord:<channel-id>
   hermes cron run <job-id>   # try it once now
   ```
   Run `hermes cron` commands as the user the gateway runs as (`docker exec -u hermes …` in the official image), so the files it writes keep the right owner.

#### Customizing

- **What gets picked:** `interests.md` in the digest directory has two sections. **Interests** describes what you want more of; it's shown to the agent when it shortlists and is what the classifier ranks against. **Skip** lists kinds of post to drop entirely, for example "I tried N+ courses"; the classifier judges them by intent, not exact words, and posts it rates at 70% or more (`MEDIUM_READER_DIGEST_SKIP_THRESHOLD`) never reach the agent. The digest ends with a count of skipped posts and names the authors or publications behind most of them, so you can mute them. There's no built-in skip list. To check that the file says what you mean, label some of your own headlines and let the tools recommend changes: see [Headline classifier](#headline-classifier).
- **Sizes:** the shortlist sizes (up to 10 from Following, 5 top picks, 10 from "For you", chunks of 5 per subagent) are plain instructions in the skill's Procedure. How much is fetched is set by `digest_begin`'s arguments; the defaults match the numbers above.
- **Output format:** `MEDIUM_READER_DIGEST_STYLE=markdown` drops the Discord-specific `<…>` around masked links. The layout itself is in `src/digest/render.ts`.
- **Schedule and delivery:** use `hermes cron edit <job-id> --schedule "…"` or `--deliver …`.

#### Things to know

- **State:** `state.json` in the digest directory holds `last_run` and the ids of every post reported, oldest first, trimmed to the newest 3,000 (`MEDIUM_READER_DIGEST_KEEP`). Only `digest_finish` and `mark_reported` write it: under a lock file, via a temporary file and a rename, with the previous version kept as `state.json.bak`. If a run dies before `digest_finish`, nothing is saved and the next run covers the same period. `last_run` is the server's clock when `digest_begin` started, and it never moves backwards.
- **Repairs:** `digest_status` shows the state and the last runs, and whether each was committed. `mark_reported` adds ids (or URLs, or refs from the latest run) and can move `last_run` forward.
- **Run files:** each `digest_begin` writes `runs/<run_id>.json` with every post it considered, the classifier's verdicts and, once finished, the picks. The newest 14 are kept. Refs (`F3`) always refer to the latest run.
- **If the classifier can't run** (no sampling support or API key, the model errors or times out, or returns something unparseable), nothing is skipped or ranked and `digest_begin` says so. The whole call stays under about three minutes, so a slow model leaves the remaining titles unrated rather than timing the tool out.
- **Tool results stay under 40,000 characters.** Hermes saves results over about 50,000 to a file the model can't parse. On a very large day `digest_begin` leaves the tail of "For you", then of Following, out of the list and says which refs; omitted Following posts are still saved as reported and listed under "Also new".
- **"For you" is read only to position 150 by default, and never past 250.** Paging to the end of that list (about 1,000 posts) makes Medium replace the list your homepage shows.
- **A post that couldn't be read** is listed under ⚠ and saved as reported; it isn't retried.
- **Read-only:** the skill never uses the tools that change your account.
- **Your own account:** this server uses Medium's undocumented web API with your session cookies. A daily digest is light, read-only use, but if Medium objects to automated access, it's your account at risk.

## Headline classifier

Before any model reads a post, a classifier decides which headlines matter to you: it **ranks** every new headline against your `interests.md` and **drops** the ones that clearly match your Skip list. It's the part of the digest that encodes your taste, so it's a separate, swappable component (`src/classifier/`) rather than part of the agent's prompt. It's optional: without a ranking backend the digest works as before.

- **Backends:** `sampling` (default; the MCP client's own model rates titles, skip only) or `jev` ([Jev](docs/jev/README.md), a decision model on OpenRouter that ranks and skips in about 2 seconds per 100 headlines, for about $0.03 per 1,000). Set `MEDIUM_READER_CLASSIFIER=jev` and `OPENROUTER_API_KEY`.
- **In the digest:** each section of the work list is sorted best first with a 0–100 rank column, so the agent starts from the top and the lowest-ranked rows are the first cut when the list is long. `MEDIUM_READER_DIGEST_RANK_FLOOR` can collapse low-ranked posts into one line.
- **Tuning it to you:** `tools/classifier/` collects headlines from your digest runs, lets you label them with one keypress each (`label.mjs`), scores them with the server's own classifier code, and analyzes the result (`analyze.mjs`). That gives recommended thresholds and the headlines where your labels and `interests.md` disagree most, which is what to edit.
- **A first draft from your activity:** ask your agent to "propose an interests.md from my Medium activity". The `interests_evidence` tool gathers your reading lists, follows, history, digest picks and labels, and `save_interests_proposal` saves the draft beside your current file. You then test it against your labels before adopting it.

How it works, the setup, the tuning loop step by step, benchmark results against a local model, and how to add a backend: **[docs/classifier.md](docs/classifier.md)**.

## Logging in

Medium has no API keys or OAuth for readers, so the server uses your normal web session.

- **Browser login (default).** `login` opens Chrome or Edge on Medium's sign-in page. Sign in however you normally do: an emailed link or code, Google, Apple, and so on. The session is captured, checked with Medium, and saved as soon as you're in. The login window keeps its own browser profile, so when the session expires (after about a year) running `login` again usually finishes without typing anything.
- **Paste.** `login --paste` is for machines without a display. Copy the `sid` **and** `uid` cookies from your browser's DevTools (Application → Cookies → medium.com); Medium ignores `sid` on its own. A `Cookie:` header (`sid=…; uid=…`), a Cookie-Editor JSON export, and `cookies.txt` all work. `login --stdin` reads the same formats from a pipe.
- **No restart needed.** The server re-reads the session on every call, so after `login` the next request just works.

> [!TIP]
> If Medium emails you a sign-in link, paste it into the address bar of the window `login` opened. Clicking it opens your normal browser instead.
>
> The login window must be a normal, visible window: Medium's Cloudflare protection blocks headless browsers.

| Command | What it does |
|---|---|
| `node dist/cli.js login` | Browser login. Add `--paste` or `--stdin` to paste cookies instead |
| `node dist/cli.js status` | Shows the logged-in account, membership, and whether the session still works |
| `node dist/cli.js logout` | Deletes the saved session. `--all` also deletes the login browser profile |
| `node dist/cli.js install` | Registers the server with Claude Code. `--scope user\|project\|local` (default `user`) |

<details>
<summary><b>Environment variables</b></summary>

| Variable | Purpose |
|---|---|
| `MEDIUM_SID`, `MEDIUM_UID` | Session cookie values. Override the saved session, for containers or CI |
| `MEDIUM_COOKIE` | A full `Cookie:` header to take `sid` and `uid` from |
| `MEDIUM_READER_HOME` | Config directory (default `~/.config/medium-reader`) |
| `MEDIUM_BROWSER_PATH` | A Chromium-based browser for `login`, if Chrome and Edge aren't installed |
| `MEDIUM_READER_DIGEST_DIR` | Directory for the digest's `state.json`, `interests.md` and `runs/`. Unset (the default) hides the digest tools |
| `MEDIUM_READER_DIGEST_TZ` | IANA time zone for dates in the digest (default `TZ`, then UTC) |
| `MEDIUM_READER_DIGEST_KEEP` | How many reported post ids to keep (default 3000) |
| `MEDIUM_READER_DIGEST_STYLE` | `discord` (default) or `markdown`: whether masked links get Discord's `<…>` |
| `MEDIUM_READER_DIGEST_SKIP_THRESHOLD` | Rater confidence at which a title is skipped, 0–1 (default 0.7) |

</details>

## Privacy and security

- **Where the session goes.** The `sid` and `uid` cookies are only ever sent to `medium.com`. Posts on custom domains are fetched from medium.com by id, so those domains never see your session.
- **What's stored.** The session is saved to `~/.config/medium-reader/auth.json` with owner-only permissions (`600`), next to the login browser profile. Nothing is stored in this repository, and `.gitignore` excludes session files in case you copy them in.
- **What leaves your machine.** Requests go only to Medium. There's no analytics or telemetry. What Claude does with the content it reads is governed by your MCP client.
- **Reading history.** Reading a post through this server doesn't add it to your Medium reading history.
- **Dependencies.** `package-lock.json` pins every dependency to an exact version and integrity hash. Install with `npm ci` for a reproducible install.

## How Medium's feeds behave

Findings from probing Medium's GraphQL API with this server's session in September 2026. They come from one account on one day, so treat them as observations rather than documented behaviour; Medium can change any of this without notice.

### "For you" is a fixed list of about 1,000 posts

- **Medium builds the list once and keeps serving it.** The paging cursor is a `source` ID (a UUID naming the list) plus an offset (`to: 25, 50, … 975`). Three fetches in a row returned the same 50 posts in the same order.
- **Paging past the end builds a new list.** After about 39 pages of 25, the next page comes from a new `source`, and later fetches, including the first page, use it. The new list is mostly the same posts reordered: a second list added only 15 posts not in the first, and the first 300 of a third added none. Going deeper reshuffles about the same 1,000 candidates rather than reaching older posts.
- **Posts range up to about a year old:** median 7 days, a quarter older than 30 days, 5% older than about 3 months, and the oldest 356 days.
- **Heads-up:** paging to the end of "For you" rebuilds the list your homepage shows. `get_feed` returns at most 100 posts per call, so this only happens if you keep following `nextCursor` about ten times.
- **Not measured:** whether a list also expires after some time without anyone paging to its end.

### The order means something, but the top isn't "most like you"

All 975 posts of one list, compared by position. "Read" means the author or publication appears in the account's reading history.

| Positions | Median age (days) | Median claps | Author you follow | Author you've read | Publication you've read |
|---|---|---|---|---|---|
| **0–25** | 22 | **1,554** | 16% | 32% | 36% |
| 25–100 | 8 | 374 | **32%** | **47%** | 36% |
| 100–250 | 11 | 411 | 24% | **47%** | 32% |
| 250–500 | 9 | 206 | 18% | 37% | 46% |
| 500–750 | 7 | 168 | 8% | 18% | 45% |
| 750–975 | 4 | 142 | 1% | 4% | 44% |

The share of member-only posts (about 75–85%) and median reading time (5–8 minutes) are about the same at every depth.

- **Positions 0–25 are popular, proven posts spread across your topics.** They're older, with 4–10 times the claps of anything deeper. The listed reasons show deliberate variety: nine topics followed ("Because you follow Startup", "…Education", "…Humor", …) got one post each, alongside "Selected for you" and a few "From your network".
- **Positions 25–250 are the most personal part.** Here are the highest shares of authors you follow and authors you've actually read.
- **Positions 500 and beyond are fresh, low-clap posts.** They're increasingly there because of network activity ("*Someone* clapped", "*Someone* responded"), and by the end almost none are from authors you've read.

So to find what a reader would actually pick, positions 25–250 matter more than the first page. To see what Medium is promoting to everyone, look at the first page. Each item's `reason` field (`reasonString` in GraphQL) says why it was included.

### The Following feed

- **It's all posts from authors and publications you follow, roughly newest first,** each tagged `PUBLISHED_BY_USER` or `PUBLISHED_BY_COLLECTION`. On the test account about 94% came through publications, from 190 posts a day, so a handful of high-volume publications made up most of the feed.
- **Reading a post doesn't remove it** from the feed.
- **Unfollowing a publication didn't remove posts already in the feed.** Muting worked straight away, and **muting an author** also hides their posts that come through publications you still follow. This is the only way to cut prolific writers out of a publication you want to keep.
- **"I'm not interested in this story"** (`SHOW_LESS`) doesn't remove the post from the Following feed. The web app only hides it on the page. Medium describes it as a recommendations signal, and its effect on "For you" can't be seen until the list is rebuilt.

### Reproducing this

`get_feed` (`feed: "for_you"`), `list_following` and `get_reading_history` return everything used here: each post's author, publication, claps, publication date and `reason`. [CLAUDE.md](CLAUDE.md) has the GraphQL details: the operations, how paging works, and what each field means.

## Troubleshooting

| Symptom | Fix |
|---|---|
| *"Not logged in"* or *"session was rejected"* | Run `node dist/cli.js login` |
| A member-only story shows *"Only a preview was returned"* | The account isn't a Medium member, or the session expired. `status` shows which |
| *"Cloudflare protection blocked the request"* | Usually temporary; wait a minute. If it persists, Medium has changed its bot rules; please open an issue. (Older versions of this server were blocked on every request under Node 26; update to fix that) |
| The server doesn't appear in `/mcp` | Restart Claude Code. New servers are only loaded when a session starts |
| `login` can't find a browser | Install Chrome, set `MEDIUM_BROWSER_PATH`, run `npx playwright install chromium`, or use `--paste` |
| The server stopped starting after a Node upgrade | `install` records the Node binary it ran with. Run it again with your current Node |

## Development

```bash
npm ci
npm test            # vitest against a fake GraphQL endpoint; no network, no account needed
npm run typecheck
npm run build       # compiles src/ to dist/
```

```
src/
  cli.ts                 entry point: serve, login, status, logout, install
  server.ts              MCP tool definitions
  format.ts              Medium's paragraph model → Markdown
  auth/credentials.ts    session storage; parses pasted cookies in any format
  auth/login.ts          browser and paste login
  medium/http.ts         GraphQL client: cookies, Cloudflare detection, retries
  medium/api.ts          queries, feed, posts, follows, lists, claps
  classifier/            headline classifier (docs/classifier.md): types.ts (the interface),
                         jev.ts (Jev via OpenRouter), sampling.ts (MCP sampling), index.ts (backend from env)
  digest/                digest tools: state.ts (atomic state), collect.ts (digest_begin),
                         render.ts (the message), finish.ts (digest_finish, status, mark_reported),
                         tools.ts (registration)
tools/classifier/        label, score and analyze your own headlines (docs/classifier.md)
experiments/jev/         the trials behind the classifier's design (scripts and write-up; data not included)
test/                    one file per module, plus an in-memory MCP client test
```

[`CLAUDE.md`](CLAUDE.md) records how Medium's GraphQL API actually behaves, including the fields that look right but aren't and how to find new queries. Read it before changing anything under `src/medium/`.

## Disclaimer

An independent project, not affiliated with or endorsed by Medium. It uses Medium's undocumented web endpoints, which can change without notice. Use it with your own account, and within Medium's [Terms of Service](https://policy.medium.com/medium-terms-of-service-9db0094a1e0f).

## License

[MIT](LICENSE) © 2026 Bill Baran. Use, modify, and share it freely; keep the copyright notice.
