import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveCredentials } from "../src/auth/credentials.js";
import { ClientProvider, createServer, parseSince } from "../src/server.js";
import { asViewer, fakeMedium, rawPost, SESSION, VIEWER } from "./helpers.js";

const saved = { ...process.env };

async function connect(handlers: Parameters<typeof fakeMedium>[0]) {
  const { fetch } = fakeMedium(handlers);
  const server = createServer(new ClientProvider(fetch));
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0]!.text;
}

const longBody = { bodyModel: { paragraphs: Array.from({ length: 200 }, (_, i) => ({ type: "P", text: `Paragraph ${i} ${"word ".repeat(10)}`, markups: [] })) } };

const handlers = {
  Viewer: asViewer(VIEWER),
  FollowingFeed: asViewer({ followingFeed: { items: [{ post: rawPost("aaaaaaaaaaaa") }], pagingInfo: { next: null } } }, { followingFeed: { items: [] } }),
  Post: asViewer(
    { post: { ...rawPost("bbbbbbbbbbbb", { isLocked: true }), wordCount: 2200, tags: [], viewerEdge: { fullContent: { isLockedPreviewOnly: false, ...longBody } } } },
    { post: { ...rawPost("bbbbbbbbbbbb", { isLocked: true }), wordCount: 2200, tags: [], viewerEdge: { fullContent: { isLockedPreviewOnly: true, bodyModel: { paragraphs: [{ type: "P", text: "Teaser" }] } } } } },
  ),
};

describe("MCP server", () => {
  beforeEach(async () => {
    process.env.MEDIUM_READER_HOME = await mkdtemp(join(tmpdir(), "medium-reader-"));
    delete process.env.MEDIUM_SID;
    delete process.env.MEDIUM_UID;
    delete process.env.MEDIUM_COOKIE;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("lists the tools with the right annotations", async () => {
    const client = await connect(handlers);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "auth_status",
      "clap",
      "follow",
      "get_feed",
      "get_list",
      "get_recent_posts",
      "list_following",
      "list_reading_lists",
      "read_post",
      "remove_from_list",
      "save_to_list",
      "search_posts",
      "undo_clap",
      "unfollow",
    ]);
    const writes = tools.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name).sort();
    expect(writes).toEqual(["clap", "follow", "remove_from_list", "save_to_list", "undo_clap", "unfollow"]);
    const destructive = tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name).sort();
    expect(destructive).toEqual(["remove_from_list", "undo_clap", "unfollow"]);
  });

  it("returns an actionable error when not logged in", async () => {
    const client = await connect(handlers);
    const result = await client.callTool({ name: "get_feed", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/medium-reader-mcp login/);
  });

  it("picks up a new login without restarting", async () => {
    const client = await connect(handlers);
    expect((await client.callTool({ name: "get_feed", arguments: {} })).isError).toBe(true);
    await saveCredentials(SESSION);
    const result = await client.callTool({ name: "get_feed", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result)).items[0]).toMatchObject({ id: "aaaaaaaaaaaa" });
    const status = JSON.parse(textOf(await client.callTool({ name: "auth_status", arguments: {} })));
    expect(status).toMatchObject({ loggedIn: true, member: true, user: { username: "tester" } });
  });

  it("warns when only a preview of a member-only story came back", async () => {
    const client = await connect(handlers);
    const out = textOf(await client.callTool({ name: "read_post", arguments: { url: "bbbbbbbbbbbb" } }));
    expect(out).toMatch(/Only a preview was returned.*not logged in/);
    expect(out).toMatch(/Words: 2200 \(preview has 1\)/);
  });

  it("pages long posts", async () => {
    await saveCredentials(SESSION);
    const client = await connect(handlers);
    const first = textOf(await client.callTool({ name: "read_post", arguments: { url: "bbbbbbbbbbbb", max_chars: 1000 } }));
    expect(first).toMatch(/^# Post bbbbbbbbbbbb/);
    expect(first).toMatch(/- Member-only story/);
    expect(first).not.toMatch(/preview/i);
    expect(first).toMatch(/Call read_post again with start=1000/);
    const second = textOf(await client.callTool({ name: "read_post", arguments: { url: "bbbbbbbbbbbb", start: 1000, max_chars: 200_000 } }));
    expect(second).not.toMatch(/^# Post/);
    expect(second).not.toMatch(/Call read_post again/);
  });
});

describe("parseSince", () => {
  it("understands relative and absolute times", () => {
    const now = Date.UTC(2026, 8, 25);
    expect(parseSince("7d", now)?.toISOString()).toBe("2026-09-18T00:00:00.000Z");
    expect(parseSince("48h", now)?.toISOString()).toBe("2026-09-23T00:00:00.000Z");
    expect(parseSince("2026-09-01")?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(parseSince(undefined)).toBeUndefined();
    expect(() => parseSince("soon")).toThrow(/Couldn't understand/);
  });
});
