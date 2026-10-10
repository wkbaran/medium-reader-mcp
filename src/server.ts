import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadCredentials, type Credentials } from "./auth/credentials.js";
import { countWords, markdownToText, paragraphsToMarkdown } from "./format.js";
import { MAX_CLAPS, MediumClient, READING_LIST, type FullPost } from "./medium/api.js";
import { digestDir } from "./config.js";
import { isDigestRef, resolveReadRef } from "./digest/finish.js";
import { registerDigestTools, registerInterestTools, registerRateHeadings } from "./digest/tools.js";
import { MediumHttp, type FetchLike } from "./medium/http.js";
import { json, run, text } from "./tool-util.js";

import { parseSince } from "./tool-util.js";

export { parseSince };

const VERSION = "0.5.1";

/**
 * Hands out a client for the current credentials. Credentials are re-read on
 * every call so that running `medium-reader-mcp login` while the server is up
 * takes effect immediately — no need to restart Claude Code.
 */
export class ClientProvider {
  private current: { key: string; client: MediumClient } | null = null;
  creds: Credentials | null = null;

  constructor(private readonly fetchImpl?: FetchLike) {}

  async get(): Promise<MediumClient> {
    this.creds = await loadCredentials();
    const session = this.creds ? { sid: this.creds.sid, uid: this.creds.uid } : undefined;
    const key = `${session?.sid ?? ""}|${session?.uid ?? ""}`;
    if (!this.current || this.current.key !== key) {
      this.current = { key, client: new MediumClient(new MediumHttp({ session, fetch: this.fetchImpl })) };
    }
    return this.current.client;
  }
}

const readOnly = { readOnlyHint: true, openWorldHint: true } as const;
const change = (opts: { destructive: boolean; idempotent: boolean }) =>
  ({ readOnlyHint: false, destructiveHint: opts.destructive, idempotentHint: opts.idempotent, openWorldHint: true }) as const;

const accountRef = z
  .string()
  .describe('An author ("@username" or profile URL) or publication (name, slug like "javarevisited", or URL like "https://pub.towardsai.net").');
const postRef = z.string().describe("Post URL (any Medium or custom-domain link) or the post's hex id.");
const listRef = z
  .string()
  .default(READING_LIST)
  .describe('"reading-list" (default) or the name / id of one of the user\'s lists, as shown by list_reading_lists.');

export function createServer(provider = new ClientProvider()): McpServer {
  const digest = digestDir();
  const server = new McpServer(
    { name: "medium-reader", version: VERSION },
    {
      instructions:
        "Read the user's Medium account: their Following feed, full member-only posts, authors and publications they follow, their reading lists, and their reading history. " +
        "Start with get_feed. follow/unfollow, mute/unmute, save_to_list/remove_from_list, and clap/undo_clap change the user's account and should only be used when asked. " +
        "If a tool reports an auth problem, tell the user to run `medium-reader-mcp login` in a terminal — do not retry in a loop." +
        (digest
          ? " For the daily digest: call digest_begin once, read the shortlisted posts with read_post (it accepts the digest's refs such as F3), then call digest_finish once and reply with the text after its ===== DIGEST line. digest_status shows the state."
          : ""),
    },
  );

  server.registerTool(
    "auth_status",
    {
      title: "Medium auth status",
      description: "Check whether a Medium session is configured and still valid, which account it belongs to, and whether it has a Medium membership (needed for member-only posts).",
      annotations: readOnly,
    },
    () =>
      run(async () => {
        const client = await provider.get();
        const creds = provider.creds;
        if (!creds) {
          return text("Not logged in. Run `medium-reader-mcp login` in a terminal. Free posts can still be read without logging in.");
        }
        const user = await client.whoami();
        return json({ loggedIn: true, user, member: Boolean(user.membership), source: creds.source, expiresAt: creds.expiresAt });
      }),
  );

  server.registerTool(
    "get_feed",
    {
      title: "Get Medium feed",
      description:
        'The user\'s home feed. "following" (default) is posts from the authors and publications they follow; "for_you" is Medium\'s recommendations. Pass nextCursor back as `cursor` for more.',
      inputSchema: {
        feed: z.enum(["following", "for_you"]).default("following"),
        limit: z.number().int().min(1).max(100).default(25),
        since: z.string().optional().describe('Only posts after this point: an ISO date ("2026-09-01") or relative ("7d", "48h").'),
        cursor: z.string().optional().describe("nextCursor from a previous call."),
      },
      annotations: readOnly,
    },
    ({ feed, limit, since, cursor }) =>
      run(async () => {
        const client = await provider.get();
        return json(await client.feed({ source: feed, limit, since: parseSince(since), cursor }));
      }),
  );

  server.registerTool(
    "read_post",
    {
      title: "Read a post",
      description:
        "Read a Medium post as Markdown. Member-only posts are returned in full when the logged-in account is a Medium member. Works for posts on custom domains too. Long posts are paged: pass `start` from the previous response to continue.",
      inputSchema: {
        url: digest ? z.string().describe("Post URL, the post's hex id, or a digest ref such as F3 from digest_begin.") : postRef,
        format: z.enum(["markdown", "text"]).default("markdown"),
        start: z.number().int().min(0).default(0).describe("Character offset into the body, for paging."),
        max_chars: z.number().int().min(1000).max(200_000).default(40_000),
      },
      annotations: readOnly,
    },
    ({ url, format, start, max_chars }) =>
      run(async () => {
        const client = await provider.get();
        const ref = digest && isDigestRef(url) ? await resolveReadRef(digest, url) : url;
        const post = await client.post(ref);
        const md = paragraphsToMarkdown(post.paragraphs, { title: post.summary.title });
        const body = format === "text" ? markdownToText(md) : md;
        const chunk = body.slice(start, start + max_chars);
        const end = start + chunk.length;
        const more =
          end < body.length
            ? `\n\n---\n[Showing characters ${start}–${end} of ${body.length}. Call read_post again with start=${end} to continue.]`
            : "";
        const header = start === 0 ? (await postHeader(client, post, md)) + "\n\n" : "";
        return text(`${header}${chunk}${more}`);
      }),
  );

  server.registerTool(
    "get_recent_posts",
    {
      title: "Get recent posts",
      description: "Latest posts from one author or publication. Pass nextCursor back as `cursor` to page back.",
      inputSchema: {
        source: accountRef,
        limit: z.number().int().min(1).max(50).default(10),
        cursor: z.string().optional().describe("nextCursor from a previous call."),
      },
      annotations: readOnly,
    },
    ({ source, limit, cursor }) =>
      run(async () => {
        const client = await provider.get();
        const result = await client.recentPosts(source, { limit, cursor });
        const { isFollowing: _f, isMuting: _m, ...account } = result.source as typeof result.source & { isFollowing?: boolean; isMuting?: boolean };
        return json({ ...result, source: account });
      }),
  );

  server.registerTool(
    "search_posts",
    {
      title: "Search Medium",
      description: "Search all of Medium for posts by keyword. Pass nextCursor back as `page` for more results.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).default(10),
        page: z.coerce.number().int().min(0).default(0),
      },
      annotations: readOnly,
    },
    ({ query, limit, page }) =>
      run(async () => {
        const client = await provider.get();
        return json(await client.search(query, { limit, page }));
      }),
  );

  server.registerTool(
    "list_following",
    {
      title: "List who you follow",
      description:
        "Authors (default) or publications the logged-in user follows. `total` is Medium's own count, which can be larger than the list Medium returns (it seems to include accounts it no longer shows).",
      inputSchema: {
        kind: z.enum(["users", "publications"]).default("users"),
        limit: z.number().int().min(1).max(200).default(50),
        cursor: z.string().optional().describe("nextCursor from a previous call."),
      },
      annotations: readOnly,
    },
    ({ kind, limit, cursor }) =>
      run(async () => {
        const client = await provider.get();
        return json(await client.following({ kind, limit, cursor }));
      }),
  );

  server.registerTool(
    "get_reading_history",
    {
      title: "Get reading history",
      description:
        "Posts the user has read on Medium, most recently read first. Medium gives no read date per post. Medium returns these in pages of 15, so `limit` is rounded up to a whole page. Pass nextCursor back as `cursor` for older reads.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(30),
        cursor: z.string().optional().describe("nextCursor from a previous call."),
      },
      annotations: readOnly,
    },
    ({ limit, cursor }) =>
      run(async () => {
        const client = await provider.get();
        return json(await client.readingHistory({ limit, cursor }));
      }),
  );

  server.registerTool(
    "list_reading_lists",
    {
      title: "List reading lists",
      description: "The user's reading list (saved posts) and their named lists, with item counts.",
      annotations: readOnly,
    },
    () =>
      run(async () => {
        const client = await provider.get();
        return json((await client.lists()).map(({ version: _v, ...l }) => l));
      }),
  );

  server.registerTool(
    "get_list",
    {
      title: "Get list posts",
      description: "Posts saved in the reading list or one of the user's named lists, most recently added first.",
      inputSchema: {
        list: listRef,
        limit: z.number().int().min(1).max(100).default(25),
        cursor: z.string().optional().describe("nextCursor from a previous call."),
      },
      annotations: readOnly,
    },
    ({ list, limit, cursor }) =>
      run(async () => {
        const client = await provider.get();
        return json(await client.listItems(list, { limit, cursor }));
      }),
  );

  server.registerTool(
    "follow",
    {
      title: "Follow",
      description:
        "Follow an author or publication. Does nothing if already following. Only use when the user explicitly asks. If the name is ambiguous the candidates are returned; ask the user which one they mean.",
      inputSchema: { target: accountRef },
      annotations: change({ destructive: false, idempotent: true }),
    },
    ({ target }) =>
      run(async () => {
        const client = await provider.get();
        return json(await client.follow(target, true));
      }),
  );

  server.registerTool(
    "unfollow",
    {
      title: "Unfollow",
      description:
        "Unfollow an author or publication. Only use when the user explicitly asks. If the name is ambiguous the candidates are returned; ask the user which one they mean.",
      inputSchema: { target: accountRef },
      annotations: change({ destructive: true, idempotent: true }),
    },
    ({ target }) =>
      run(async () => {
        const client = await provider.get();
        return json(await client.follow(target, false));
      }),
  );

  server.registerTool(
    "mute",
    {
      title: "Mute",
      description:
        "Mute an author or publication so their posts stop appearing in the user's feeds, including posts an author publishes in publications the user follows. Muting is private. Only use when the user explicitly asks. If the name is ambiguous the candidates are returned; ask the user which one they mean.",
      inputSchema: { target: accountRef },
      annotations: change({ destructive: false, idempotent: true }),
    },
    ({ target }) =>
      run(async () => {
        const client = await provider.get();
        return json(await client.mute(target, true));
      }),
  );

  server.registerTool(
    "unmute",
    {
      title: "Unmute",
      description: "Unmute an author or publication. Only use when the user explicitly asks.",
      inputSchema: { target: accountRef },
      annotations: change({ destructive: false, idempotent: true }),
    },
    ({ target }) =>
      run(async () => {
        const client = await provider.get();
        return json(await client.mute(target, false));
      }),
  );

  server.registerTool(
    "save_to_list",
    {
      title: "Save to list",
      description: "Save a post to the reading list (default) or one of the user's named lists. Does nothing if it's already there. Only use when the user asks.",
      inputSchema: { post: postRef, list: listRef },
      annotations: change({ destructive: false, idempotent: true }),
    },
    ({ post, list }) =>
      run(async () => {
        const client = await provider.get();
        return json(await client.saveToList(post, list));
      }),
  );

  server.registerTool(
    "remove_from_list",
    {
      title: "Remove from list",
      description: "Remove a post from the reading list (default) or one of the user's named lists. Only use when the user asks.",
      inputSchema: { post: postRef, list: listRef },
      annotations: change({ destructive: true, idempotent: true }),
    },
    ({ post, list }) =>
      run(async () => {
        const client = await provider.get();
        return json(await client.removeFromList(post, list));
      }),
  );

  server.registerTool(
    "clap",
    {
      title: "Clap for a post",
      description: `Clap for a post (visible to its author). Medium allows ${MAX_CLAPS} claps per reader per post in total; this refuses to go past that. Only use when the user asks. undo_clap takes them back.`,
      inputSchema: {
        post: postRef,
        count: z.number().int().min(1).max(MAX_CLAPS).default(1),
      },
      annotations: change({ destructive: false, idempotent: false }),
    },
    ({ post, count }) =>
      run(async () => {
        const client = await provider.get();
        return json(await client.clap(post, count));
      }),
  );

  server.registerTool(
    "undo_clap",
    {
      title: "Undo claps",
      description: "Remove all of the user's claps from a post. Only use when the user asks.",
      inputSchema: { post: postRef },
      annotations: change({ destructive: true, idempotent: true }),
    },
    ({ post }) =>
      run(async () => {
        const client = await provider.get();
        return json(await client.clap(post, 0));
      }),
  );

  registerRateHeadings(server);
  registerInterestTools(server, provider, digest);
  if (digest) registerDigestTools(server, provider, digest);

  return server;
}

export async function serve(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

// ---- helpers ----

async function postHeader(client: MediumClient, post: FullPost, md: string): Promise<string> {
  const s = post.summary;
  let warning: string | null = null;
  if (post.previewOnly) {
    if (!client.authenticated) {
      warning = "- ⚠️ Only a preview was returned: this is a member-only story and you're not logged in. Run `medium-reader-mcp login`.";
    } else {
      const user = await client.whoami().catch(() => null);
      warning = user
        ? user.membership
          ? "- ⚠️ Only a preview was returned even though the account is a member. Medium may be limiting access to this story."
          : "- ⚠️ Only a preview was returned: this is a member-only story and the logged-in account isn't a Medium member."
        : "- ⚠️ Only a preview was returned: the saved Medium session was rejected. Run `medium-reader-mcp login`.";
    }
  }
  const lines = [
    `# ${s.title}`,
    s.subtitle ? `_${s.subtitle}_` : null,
    "",
    s.author ? `- Author: ${s.author}${s.authorUsername ? ` (@${s.authorUsername})` : ""}` : null,
    s.publication ? `- Publication: ${s.publication}` : null,
    s.published ? `- Published: ${s.published.slice(0, 10)}` : null,
    s.url ? `- URL: ${s.url}` : null,
    `- ID: ${s.id}`,
    `- Access: ${post.previewOnly ? "preview-only" : "full"}`,
    s.readingMinutes ? `- Reading time: ${s.readingMinutes} min` : null,
    `- Words: ${post.wordCount ?? countWords(md)}${post.previewOnly ? ` (preview has ${countWords(md)})` : ""}`,
    s.claps != null ? `- Claps: ${s.claps}` : null,
    post.tags.length ? `- Tags: ${post.tags.join(", ")}` : null,
    s.memberOnly ? "- Member-only story" : null,
    warning,
  ].filter((l): l is string => l !== null);
  return lines.join("\n");
}
