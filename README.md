<div align="center">

# Medium Reader MCP

**Ask Claude what's new in your Medium feed, and have it read member-only stories for you.**

![Node 20+](https://img.shields.io/badge/node-20%2B-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-stdio-6E56CF)
![Tools](https://img.shields.io/badge/tools-19%20%2B%205%20digest-informational)
![Jev](https://img.shields.io/badge/ranking-Jev%20decision%20model-orange)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

[Quick start](#quick-start) · [Tools](#tools) · [Daily digest](#daily-digest-with-hermes-agent) · [Headline ranking with Jev](#headline-ranking-with-jev) · [Logging in](#logging-in) · [Troubleshooting](#troubleshooting)

</div>

An MCP server for your own Medium account:

- **Read:** your Following and For you feeds, full member-only posts, search, reading lists, follows and history.
- **Act, when you ask:** follow and unfollow, mute, save to lists, clap.
- **Daily digest:** with [Hermes Agent](https://github.com/NousResearch/hermes-agent), a scheduled morning digest. [Jev](#headline-ranking-with-jev) can rank every headline against your interests before an LLM reads anything.
- **No API keys for Medium:** you log in once in a browser window.

## What it uses

| What | Needed? |
|---|---|
| Your [Medium](https://medium.com) account | Yes. A [membership](https://medium.com/membership) is needed to read member-only stories in full |
| Node.js 20+ | Yes |
| Chrome or Edge | Only for the browser login (you can paste cookies instead) |
| A [Jev](docs/jev/README.md)-style decision model | Optional. Ranks digest headlines against your interests in about 2 s per 100. Any provider with the same decisions API works, set by URL, key and model like an OpenAI-compatible client. The default is TypeSafe's Jev on [OpenRouter](https://openrouter.ai/typesafe/jev-1.13), about $0.03 per 1,000 headlines |
| An MCP client | Claude Code, Claude Desktop, Cursor, VS Code, Hermes Agent… |

How it talks to Medium:

- **Medium's own web endpoint:** Medium has no reading API, so the server calls the GraphQL endpoint medium.com uses, with your session. It sees only what you see logged in.
- **HTTP/1.1 through `undici`:** Medium's Cloudflare blocks Node's HTTP/2 `fetch`, which Node 26 uses by default.

## Quick start

```bash
git clone https://github.com/wkbaran/medium-reader-mcp.git
cd medium-reader-mcp
npm install && npm run build

node dist/cli.js login     # a browser window opens; sign in to Medium as usual
node dist/cli.js install   # registers the server with Claude Code
```

Restart Claude Code, then try:

- *"What's new in my Medium feed today?"*
- *"Summarize that Towards AI post about schema drift."*
- *"Which authors I follow post the most but I never read?"*
- *"Propose an interests.md from my Medium activity."*
- *"Save this post to my AI list."* (Claude asks before every change)

<details>
<summary><b>Other MCP clients</b> (Claude Desktop, Cursor, VS Code)</summary>

Point the client at `dist/cli.js` with an absolute path, after running `login`:

```json
{ "mcpServers": { "medium-reader": { "command": "node", "args": ["/absolute/path/to/medium-reader-mcp/dist/cli.js"] } } }
```

- **Claude Desktop:** `claude_desktop_config.json` (Settings → Developer → Edit Config)
- **Cursor:** `~/.cursor/mcp.json`
- **VS Code:** `.vscode/mcp.json`, using `"servers"` instead of `"mcpServers"` and adding `"type": "stdio"`
- **Claude Code, manually:** `claude mcp add --scope user medium-reader -- node /absolute/path/to/dist/cli.js`
</details>

## Tools

How to name things:

- **Authors:** `@username` or a profile URL.
- **Publications:** a name, slug or URL, including custom domains.
- **Posts:** any Medium link, or the post's hex id.

**Reading** (all read-only)

| Tool | What it returns |
|---|---|
| `get_feed` | Your **Following** feed (default) or **For you**, newest first. `since` takes `"7d"`, `"48h"` or a date |
| `read_post` | A full post as Markdown. Member-only stories you can't access are flagged as previews |
| `get_recent_posts` · `search_posts` | One author's or publication's latest posts · keyword search across Medium |
| `list_following` · `list_reading_lists` · `get_list` | Who you follow · your lists · the posts in one list |
| `get_reading_history` | Posts you've read, most recent first (Medium gives no read dates) |
| `rate_headings` | Rates headlines against conditions you define, using your MCP client's own model ([sampling](#headline-ranking-with-jev)) |
| `interests_evidence` | What your activity says about your taste, for [drafting an interests.md](docs/classifier.md#proposing-an-interestsmd-from-your-activity) |
| `auth_status` | Who you're logged in as, and whether you're a member |

**Account changes** (clients ask first; the server re-checks with Medium afterwards)

| Tool | What it does |
|---|---|
| `follow` / `unfollow` | Follow or unfollow an author or publication. An ambiguous name lists the matches instead of guessing |
| `mute` / `unmute` | Hide an author's or publication's posts, including an author's posts in publications you follow. Private |
| `save_to_list` / `remove_from_list` | Add a post to, or remove it from, a list |
| `clap` / `undo_clap` | Clap (up to Medium's 50 per post), or take your claps back |

Follows and claps are visible to the author, and named lists are public.

**Digest** (only when `MEDIUM_READER_DIGEST_DIR` is set; plain-text output for agent harnesses)

| Tool | What it does |
|---|---|
| `digest_begin` | Collects what's new, ranks and filters it, and returns a work list with refs (`F3`, `T1`, `Y12`) |
| `digest_finish` | Takes the picks by ref, renders the message and saves state. Safe to repeat |
| `digest_status` · `mark_reported` | Inspect the state · repair it |
| `save_interests_proposal` | Saves a drafted `interests.md` as `interests.proposed.md`, never over the real one |

## Daily digest with Hermes Agent

[Hermes Agent](https://github.com/NousResearch/hermes-agent) runs skills on a schedule and delivers to Discord and other chats. [`hermes/SKILL.md`](hermes/SKILL.md) turns this server into a morning digest:

- **What it covers:** new posts from Following, Medium's top picks, and your personal "For you" positions 25–100.
- **How it's chosen:** Jev ranks and filters the headlines, then subagents read the best 20–25 in full.
- **What you get:** one message, with ⭐ "Read in full" picks that each have a summary and a reason.
- **What the model does:** only the judging. Fetching, state and layout are code, which took a Sonnet run from about $2.50 to $0.40.

**Setup**

1. **Build** (`npm ci && npm run build`) and copy `dist/`, `package.json` and `package-lock.json` to where Hermes can see them, e.g. `/opt/data/mcp/medium-reader-mcp`. Then run `npm ci --omit=dev --omit=optional` there.
2. **Log in** on a machine with a browser (`node dist/cli.js login`), then copy `~/.config/medium-reader/auth.json` to the Hermes host, e.g. `/opt/data/mcp/medium-reader-home/`.
3. **Create the digest directory**, e.g. `/opt/data/sandbox/medium_digest`, with an `interests.md` (start from `hermes/interests.example.md`, or [draft one from your activity](docs/classifier.md#proposing-an-interestsmd-from-your-activity)).
4. **Register the server** in Hermes's `config.yaml`:
   ```yaml
   mcp_servers:
     medium-reader:
       command: node
       args: ["/opt/data/mcp/medium-reader-mcp/dist/cli.js"]
       env:
         MEDIUM_READER_HOME: /opt/data/mcp/medium-reader-home
         MEDIUM_READER_DIGEST_DIR: /opt/data/sandbox/medium_digest
         MEDIUM_READER_DIGEST_TZ: America/Denver
         MEDIUM_READER_CLASSIFIER: jev                          # rank with Jev (default: sampling)
         MEDIUM_READER_JEV_API_KEY: ${JEV_OPENROUTER_API_KEY}   # from Hermes's .env
         # MEDIUM_READER_JEV_URL: https://openrouter.ai/api/alpha/decisions   # the default; any decisions-API endpoint
   ```
5. **Install the skill:** copy `hermes/SKILL.md` to `skills/productivity/medium-digest/` and `hermes/medium_digest_start.sh` to `scripts/`. Then edit the skill's Settings block.
6. **Schedule it** (run as the `hermes` user). The job needs only the `delegation` and `medium-reader` toolsets:
   ```bash
   hermes cron create "0 7 * * *" "Run the medium-digest skill and deliver the digest." \
     --name medium-digest --skill medium-digest --script medium_digest_start.sh --deliver discord:<channel-id>
   ```

More detail is in **[docs/digest.md](docs/digest.md)**: why the server has harness-specific tools, customizing, state and repairs, and limits.

## Headline ranking with Jev

The digest's first step is deciding which of a day's 100–200 headlines matter to you, before anything is read. That's the classifier (`src/classifier/`), kept separate from summarizing and presenting.

- **[Jev](docs/jev/README.md)** is a "decision model" from TypeSafe. It returns typed answers with probabilities, not text. For every headline it gives:
  - a **rank** (how much you'd want it, judged against `interests.md`)
  - a **skip** probability (whether it matches your Skip list)
- **In the work list:** each section is sorted best first with a rank column. Confident skips are dropped. Low ranks sink, so the agent starts from the top, and on a big day the bottom is what gets cut.
- **Measured on real labels:**
  - Against a local 27B model: Jev's top 10 were all posts the reader wanted, against 7 of 10, and it took 3 s instead of 178 s for 160 headlines.
  - [Details](docs/classifier.md#evidence).
- **Backends** (`MEDIUM_READER_CLASSIFIER`):
  - **`jev`**: ranks and skips. The server calls the decisions API itself over HTTPS, not through sampling.
  - **`sampling`** (default): skips only. The server asks your MCP client's own model to rate each headline, which is what *MCP sampling* means: the server borrows the client's LLM rather than having its own (in Hermes, `auxiliary.mcp` or `mcp_servers.<name>.sampling.model`). It doesn't rank, so the order of posts is left to the agent's model when it shortlists.
  - **`off`**.
- **Any Jev-style provider:** the `jev` backend speaks the decisions API (POST `model`, `state`, `questions` → `answers`), and you point it at a provider the way you'd point an OpenAI-compatible client at a local model:
  - `MEDIUM_READER_JEV_URL`: the endpoint. Default: OpenRouter's `https://openrouter.ai/api/alpha/decisions`. TypeSafe's System One API (`…/v1/systemone`) and compatible or self-hosted servers work too.
  - `MEDIUM_READER_JEV_API_KEY`: the bearer token (falls back to `OPENROUTER_API_KEY`). It can be empty for a server without auth.
  - `MEDIUM_READER_JEV_MODEL`: the model id. Default `typesafe/jev-1.13`; TypeSafe's own API uses `jev-1.13`.
- **Tune it to you:** label your own headlines with one keypress each, and the tools recommend thresholds and edits to `interests.md`. They can also draft an `interests.md` from your reading lists, follows and history.

Everything about it is in **[docs/classifier.md](docs/classifier.md)**: settings, the tuning loop, drafting from activity, evidence, and adding a backend.

## Logging in

- **Browser (default):** `login` opens Chrome or Edge on Medium's sign-in page. The session is saved as soon as you're in and lasts about a year. Re-running `login` usually needs no typing.
- **Paste:** `login --paste` (or `--stdin`) takes the `sid` **and** `uid` cookies in any format: a `Cookie:` header, a Cookie-Editor export, or `cookies.txt`.
- **No restart needed:** the server re-reads the session on every call.
- **Tips:**
  - If Medium emails you a sign-in link, paste it into the `login` window.
  - The window must be visible, because Cloudflare blocks headless browsers.

| Command | What it does |
|---|---|
| `node dist/cli.js login` | Log in (`--paste` / `--stdin` to paste cookies) |
| `node dist/cli.js status` | The logged-in account, membership, and whether the session works |
| `node dist/cli.js logout` | Delete the session (`--all` also deletes the login browser profile) |
| `node dist/cli.js install` | Register with Claude Code (`--scope user\|project\|local`) |

<details>
<summary><b>Environment variables</b></summary>

| Variable | Purpose |
|---|---|
| `MEDIUM_SID`, `MEDIUM_UID`, `MEDIUM_COOKIE` | Session cookies, overriding the saved session (containers, CI) |
| `MEDIUM_READER_HOME` | Config directory (default `~/.config/medium-reader`) |
| `MEDIUM_BROWSER_PATH` | A Chromium-based browser for `login` |
| `MEDIUM_READER_DIGEST_DIR` | Digest directory; setting it turns on the digest tools |
| `MEDIUM_READER_DIGEST_TZ` | Time zone for digest dates (default `TZ`, then UTC) |
| `MEDIUM_READER_DIGEST_KEEP` | Reported post ids to keep (default 3000) |
| `MEDIUM_READER_DIGEST_STYLE` | `discord` (default) or `markdown` |
| `MEDIUM_READER_CLASSIFIER` | `jev`, `sampling` (default) or `off` |
| `MEDIUM_READER_JEV_URL` | Decisions-API endpoint for `jev` (default OpenRouter's) |
| `MEDIUM_READER_JEV_API_KEY` | Bearer token for that endpoint (default `OPENROUTER_API_KEY`) |
| `MEDIUM_READER_JEV_MODEL` | Model id (default `typesafe/jev-1.13`) |
| `MEDIUM_READER_DIGEST_SKIP_THRESHOLD` | Skip probability at which a headline is dropped (default 0.7) |
| `MEDIUM_READER_DIGEST_RANK_FLOOR` | Rank below which posts are collapsed to one line (default off) |

</details>

## Privacy and security

- **Your session goes only to `medium.com`.** Custom-domain posts are fetched from medium.com by id.
- **It's stored in `~/.config/medium-reader/auth.json`**, mode `600`. Nothing is stored in the repo.
- **No telemetry.** Requests go only to Medium, and to your Jev provider if it's on (headlines and your interests only).
- **Reading through this server doesn't add posts** to your Medium reading history.
- **`package-lock.json` pins every dependency;** install with `npm ci`.

## How Medium's feeds behave

The digest's design rests on a few findings, written up in **[docs/feeds.md](docs/feeds.md)**:

- **"For you" is a fixed list of about 1,000 posts.** Paging to its end makes Medium rebuild your homepage list.
- **Positions 0–25 are popular posts for everyone;** positions 25–250 are the most personal part of the list.
- **Muting an author** is the only way to hide their posts in publications you still follow.

## Troubleshooting

| Symptom | Fix |
|---|---|
| *"Not logged in"* / *"session was rejected"* | `node dist/cli.js login` |
| *"Only a preview was returned"* | Not a member, or the session expired; `status` shows which |
| *"Cloudflare protection blocked the request"* | Usually temporary. If it persists, Medium changed its bot rules; please open an issue |
| The server doesn't appear in `/mcp` | Restart Claude Code |
| `login` can't find a browser | Install Chrome, set `MEDIUM_BROWSER_PATH`, or use `--paste` |
| The digest says `Classifier … unavailable` | For `jev`, check `MEDIUM_READER_JEV_URL` and the key; for `sampling`, the client's sampling setup |

## Development

```bash
npm ci && npm test     # vitest against a fake GraphQL endpoint; no network needed
npm run typecheck && npm run build
```

- **`src/medium/`**: the GraphQL client and queries.
- **`src/digest/`**: the digest tools.
- **`src/classifier/`**: the headline classifier, shared with [substack-reader-mcp](https://github.com/wkbaran/substack-reader-mcp).
- **`tools/classifier/`**: label, score, analyze, propose.
- **`experiments/jev/`**: the trials behind the classifier.
- **[CLAUDE.md](CLAUDE.md)**: how Medium's API actually behaves. Read it before changing `src/medium/`.

## Disclaimer

An independent project, not affiliated with or endorsed by Medium or TypeSafe. It uses Medium's undocumented web endpoints, which can change without notice. Use it with your own account, within Medium's [Terms of Service](https://policy.medium.com/medium-terms-of-service-9db0094a1e0f).

## License

[MIT](LICENSE) © 2026 Bill Baran.
