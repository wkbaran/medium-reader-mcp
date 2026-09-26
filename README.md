<div align="center">

# Medium Reader MCP

**Ask Claude what's new in your Medium feed, and have it read member-only stories for you.**

An MCP server that gives Claude (and any other MCP client) access to your Medium account: your Following and For you feeds, full member-only posts, the authors and publications you follow, search, and your reading lists. It can also follow and unfollow, save posts to lists, and clap. You log in once in a browser window; no API keys or cookie exporting.

![Node 20+](https://img.shields.io/badge/node-20%2B-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-stdio-6E56CF)
![Tools](https://img.shields.io/badge/tools-17-informational)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

[Quick start](#quick-start) · [Other clients](#other-mcp-clients) · [Hermes digest](#daily-digest-with-hermes-agent) · [Tools](#tools) · [Logging in](#logging-in) · [Privacy and security](#privacy-and-security) · [How Medium's feeds behave](#how-mediums-feeds-behave) · [Troubleshooting](#troubleshooting)

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

## Daily digest with Hermes Agent

[`hermes/`](hermes/) contains a skill for [Hermes Agent](https://github.com/NousResearch/hermes-agent) that turns this server into a scheduled Medium digest. Each morning it collects new posts from your Following feed and from "For you", filters out clickbait, has subagents read the most promising 20–25 in full, and sends one message with three sections: Following, Medium's top picks (positions 0–25 of "For you") and personal recommendations (positions 25–100). The top posts are flagged ⭐ "Read in full", with a two-line summary and why they're worth reading. The design follows the findings in [How Medium's feeds behave](#how-mediums-feeds-behave).

### Setup

1. **Build the server** on your machine (`npm ci && npm run build`). Copy `dist/`, `package.json` and `package-lock.json` to a directory the Hermes container can see (for example `$HERMES_HOME/mcp/medium-reader-mcp`, which is `/opt/data/mcp/medium-reader-mcp` inside the official image), and install the runtime dependencies there:
   ```bash
   npm ci --omit=dev --omit=optional
   ```
   Node 20 or later works, including the Node 26 in the Hermes image.
2. **Log in** on a machine with a browser (`node dist/cli.js login`), then copy `~/.config/medium-reader/auth.json` into a directory on the Hermes host, for example `$HERMES_HOME/mcp/medium-reader-home/`. Keep it at owner-only permissions.
3. **Register the server** in Hermes's `config.yaml`:
   ```yaml
   mcp_servers:
     medium-reader:
       command: node
       args: ["/opt/data/mcp/medium-reader-mcp/dist/cli.js"]
       env:
         MEDIUM_READER_HOME: /opt/data/mcp/medium-reader-home
   ```
4. **Install the skill:** copy `hermes/SKILL.md` to `$HERMES_HOME/skills/productivity/medium-digest/SKILL.md`, and `hermes/medium_digest_start.sh` to `$HERMES_HOME/scripts/`. Optionally, copy `hermes/interests.example.md` to `STATE_DIR/interests.md` and edit it (see below).
5. **Edit the Settings block** at the top of `SKILL.md`: `STATE_DIR`, `TIMEZONE`, `MAX_PARALLEL` and the `REAUTH` message.
6. **Restart Hermes and schedule it.** Cron times are in the Hermes host's local time:
   ```bash
   hermes cron create "0 7 * * *" "Run the medium-digest skill and deliver the digest." \
     --name medium-digest --skill medium-digest --script medium_digest_start.sh --deliver discord:<channel-id>
   hermes cron run <job-id>   # try it once now
   ```
   Run `hermes cron` commands as the user the gateway runs as (`docker exec -u hermes …` in the official image), so the files it writes keep the right owner.

### Customizing

- **What gets picked:** `STATE_DIR/interests.md` is free text the skill reads on every run. Describe what you want more of. Its **Skip** section lists title patterns to drop entirely, for example "I tried N+ courses" or "passive income". Matching is by intent, not exact words. The digest ends with a count of skipped posts and names the authors who produce most of them, so you can mute them.
- **Sizes:** the numbers in the Procedure section (up to 10 picks from Following, 5 top picks, 10 from "For you", chunks of 5 per subagent) are plain instructions, so edit them directly.
- **Output format:** the message template targets Discord Markdown. For Telegram, Slack or email, edit the template in the "Send the digest" step and the formatting rules under it.
- **Schedule and delivery:** use `hermes cron edit <job-id> --schedule "…"` or `--deliver …`.

### Things to know

- **Tool results over about 50,000 characters don't reach the model.** Hermes saves them to a file the model can't parse, and cron runs can't run scripts to help. That's why the skill asks for results in smaller pages. Keep that in mind if you raise the limits.
- **"For you" is only read to position 150.** Paging to the end of that list (about 1,000 posts) makes Medium replace the list your homepage shows.
- **State:** each run records what it reported in `STATE_DIR/state.json`, so posts never repeat. A run that fails doesn't save state, so the next run covers the same period.
- **Read-only:** the skill never uses the tools that change your account.
- **Cost:** the first run made 34 model calls and took about 12 minutes on Claude Sonnet, most of it the subagents reading posts in full. Some of that was working around results that were too large, which the current skill avoids.
- **Your own account:** this server uses Medium's undocumented web API with your session cookies. A daily digest is light, read-only use, but if Medium objects to automated access, it's your account at risk.

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

### Account changes

| Tool | What it does |
|---|---|
| `follow` / `unfollow` | Follow or unfollow an author or publication. An ambiguous name lists the matches instead of guessing |
| `mute` / `unmute` | Hide an author's or publication's posts from your feeds, including an author's posts in publications you follow. Private |
| `save_to_list` / `remove_from_list` | Add a post to, or remove it from, your reading list or a named list |
| `clap` / `undo_clap` | Clap for a post (never past Medium's 50-per-post limit), or take your claps back |

The reading tools are marked read-only. The rest are marked as changing your account, so MCP clients ask before running them. `unfollow`, `remove_from_list` and `undo_clap` are also marked destructive. After each change the server checks with Medium and reports what actually happened; doing something that's already done (following someone you follow, saving a saved post) changes nothing.

Follows and claps are visible to the author, and named lists are public. Mutes are private.

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
test/                    one file per module, plus an in-memory MCP client test
```

[`CLAUDE.md`](CLAUDE.md) records how Medium's GraphQL API actually behaves, including the fields that look right but aren't and how to find new queries. Read it before changing anything under `src/medium/`.

## Disclaimer

An independent project, not affiliated with or endorsed by Medium. It uses Medium's undocumented web endpoints, which can change without notice. Use it with your own account, and within Medium's [Terms of Service](https://policy.medium.com/medium-terms-of-service-9db0094a1e0f).

## License

[MIT](LICENSE) © 2026 Bill Baran. Use, modify, and share it freely; keep the copyright notice.
