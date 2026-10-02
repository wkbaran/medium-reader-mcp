import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveCredentials } from "../src/auth/credentials.js";
import { DIGEST_MARKER } from "../src/digest/finish.js";
import { ClientProvider, createServer } from "../src/server.js";
import { asViewer, fakeMedium, forYouList, rawPost, SESSION, VIEWER, type GqlRequest, type Reply } from "./helpers.js";

const saved = { ...process.env };
let dir: string;

const hex = (prefix: string, n: number) => prefix + n.toString(16).padStart(12 - prefix.length, "0");
const recent = (id: string, extra: Record<string, unknown> = {}) => rawPost(id, { firstPublishedAt: Date.UTC(2026, 8, 30), ...extra });

/** Following feed served by offset, like Medium. */
function followingList(posts: Array<Record<string, unknown>>) {
  return (req: GqlRequest): Reply => {
    const p = req.variables.paging as { to?: string; limit?: number };
    const off = Number(p.to ?? 0);
    const lim = p.limit ?? 25;
    const slice = posts.slice(off, off + lim);
    const next = off + lim < posts.length ? { to: String(off + lim), limit: lim, source: "" } : null;
    return { data: { followingFeed: { items: slice.map((post) => ({ reason: 1, postProviderExplanation: { reason: "PUBLISHED_BY_COLLECTION" }, post })), pagingInfo: { next } } } };
  };
}

const history = (posts: Array<Record<string, unknown>>): Reply => ({
  data: { viewer: { id: SESSION.uid, readingHistory: { postPreviewConnection: { postPreviews: posts.map((post) => ({ postId: post.id, post })), pagingInfo: { next: null } } } } },
});

/** A model behind MCP sampling: anything with "$" in it is a skip. */
function samplingModel(prompts: string[]) {
  return async (req: { params: { messages: Array<{ content: unknown }> } }) => {
    const content = req.params.messages[0]!.content as { text: string };
    prompts.push(content.text);
    const lines = content.text.split("\n").filter((l) => /^\d+\. /.test(l));
    const out = lines.map((l) => ({ i: Number(l.split(".")[0]), skip: l.includes("$") ? 0.9 : 0.1, skip_why: l.includes("$") ? "money bait" : "ok" }));
    return { role: "assistant" as const, model: "fake", content: { type: "text" as const, text: "```json\n" + JSON.stringify(out) + "\n```" } };
  };
}

async function connect(handlers: Parameters<typeof fakeMedium>[0], opts: { sampling?: boolean; prompts?: string[] } = {}) {
  const { fetch, requests } = fakeMedium({ Viewer: asViewer(VIEWER), ...handlers });
  const server = createServer(new ClientProvider(fetch));
  const client = new Client({ name: "test", version: "0" }, opts.sampling ? { capabilities: { sampling: {} } } : {});
  if (opts.sampling) client.setRequestHandler(CreateMessageRequestSchema, samplingModel(opts.prompts ?? []));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, requests };
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0]!.text;
}

const INTERESTS = "# Interests file\n\n## Interests\n- Databases\n\n## Skip\n- Anything about earning money\n";

beforeEach(async () => {
  process.env.MEDIUM_READER_HOME = await mkdtemp(join(tmpdir(), "medium-reader-"));
  dir = await mkdtemp(join(tmpdir(), "medium-digest-"));
  process.env.MEDIUM_READER_DIGEST_DIR = dir;
  process.env.MEDIUM_READER_DIGEST_TZ = "America/Denver";
  delete process.env.MEDIUM_SID;
  delete process.env.MEDIUM_UID;
  delete process.env.MEDIUM_COOKIE;
  await saveCredentials(SESSION);
});
afterEach(() => {
  process.env = { ...saved };
});

describe("digest tools", () => {
  it("are listed only when MEDIUM_READER_DIGEST_DIR is set, with the right annotations", async () => {
    const { client } = await connect({});
    const { tools } = await client.listTools();
    const digest = tools.filter((t) => /^digest_|^mark_reported$/.test(t.name));
    expect(digest.map((t) => t.name).sort()).toEqual(["digest_begin", "digest_finish", "digest_status", "mark_reported"]);
    const ann = Object.fromEntries(digest.map((t) => [t.name, t.annotations]));
    expect(ann.digest_status).toMatchObject({ readOnlyHint: true });
    expect(ann.digest_finish).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(ann.mark_reported).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(ann.digest_begin).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(tools.find((t) => t.name === "rate_headings")!.annotations).toMatchObject({ readOnlyHint: true });

    delete process.env.MEDIUM_READER_DIGEST_DIR;
    const plain = await connect({});
    const names = (await plain.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("rate_headings");
    expect(names.filter((n) => /^digest_|^mark_reported$/.test(n))).toEqual([]);
  });

  it("runs a whole digest: begin, read by ref, finish, and repeat safely", async () => {
    const reportedId = hex("f", 99);
    await writeFile(join(dir, "state.json"), JSON.stringify({ last_run: "2026-09-29T12:00:00Z", reported_posts: [reportedId] }, null, 2) + "\n");
    await writeFile(join(dir, "interests.md"), INTERESTS);
    const following = [
      recent(hex("f", 1), { title: "Postgres vacuum, explained", creator: { id: "a", name: "Fav Author", username: "fav" } }),
      recent(hex("f", 2), { title: "I made $10k in a month", creator: { id: "b", name: "Hustler", username: "hustler" } }),
      recent(hex("f", 3), { collection: { id: "c", name: "Big Pub", slug: "big" } }),
      recent(reportedId),
      recent(hex("f", 4)),
    ];
    const forYou = Array.from({ length: 120 }, (_, i) => rawPost(hex("b", i)));
    forYou[3] = rawPost(hex("f", 3)); // also in Following → dropped from Top picks
    forYou[30] = rawPost(reportedId); // already reported → dropped from For you
    const prompts: string[] = [];
    const { client, requests } = await connect(
      {
        FollowingFeed: followingList(following),
        RecommendedFeed: forYouList(forYou),
        ReadingHistory: history([rawPost(hex("e", 1), { creator: { id: "a", name: "Fav Author", username: "fav" } })]),
        Post: (req) => ({ data: { post: { ...recent(String(req.variables.id)), wordCount: 900, tags: [], viewerEdge: { fullContent: { isLockedPreviewOnly: false, bodyModel: { paragraphs: [{ type: "P", text: "Body." }] } } } } } }),
      },
      { sampling: true, prompts },
    );

    const begin = await client.callTool({ name: "digest_begin", arguments: {} });
    expect(begin.isError).toBeFalsy();
    const view = textOf(begin);
    expect(view).toMatch(/^Medium digest run \d{8}T\d{6}Z · member: yes\nSince: Tue, Sep 29, 6:00 AM MDT \(2026-09-29T12:00:00Z\)/);
    expect(view).toContain("Following: 4 new (1 already reported) · Top picks: 24 (1 dropped) · For you: 74 from positions 25–100 (1 dropped)");
    expect(view).toContain("Rater: 1 skipped (threshold 70%)");
    expect(view).toContain("You read: @fav ×1");
    expect(view).toContain("Interests:\n- Databases");
    expect(view).toMatch(/\nF1 \| Postgres vacuum, explained \| Fav Author \| - \| 4 \| 10 \| R\n/);
    expect(view).toContain("## Skipped by rater\nF2 I made $10k in a month");
    expect(view).not.toMatch(/\nF2 \|/);
    expect(view).toMatch(/\nT1 \| Post b00000000000 \| .* \| follow:Coding\n/);
    expect(view).toContain("## For you\nY1 | Post b00000000019");
    expect(prompts.join("\n")).toContain("Anything about earning money");
    // For you was read by position and never past 100 (enough posts, so no extension).
    const offsets = requests.filter((r) => r.operationName === "RecommendedFeed").map((r) => Number((r.variables.paging as { to?: string }).to ?? 0));
    expect(Math.max(...offsets)).toBe(75);
    // Nothing committed yet.
    expect(JSON.parse(await readFile(join(dir, "state.json"), "utf8")).reported_posts).toEqual([reportedId]);

    const read = textOf(await client.callTool({ name: "read_post", arguments: { url: "f1", format: "text" } }));
    expect(read).toContain(`- ID: ${hex("f", 1)}`);
    expect(read).toContain("- Access: full");
    const missing = await client.callTool({ name: "read_post", arguments: { url: "F99" } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/F99 isn't in the latest digest run .*F1–F4, T1–T24, Y1–Y74/);

    const picks = {
      starred: [{ ref: "F1", gist: "How vacuum reclaims space.", why: "Benchmarks you can't get from the gist." }],
      following: [{ ref: "F3", gist: "A Big Pub post." }],
      top_picks: [{ ref: "T2", gist: "A top pick." }],
      for_you: JSON.stringify([{ ref: "y1", gist: "Picked for you." }]),
      unreadable: "Y2",
    };
    const stateBefore = await readFile(join(dir, "state.json"), "utf8");
    const dry = textOf(await client.callTool({ name: "digest_finish", arguments: { ...picks, dry_run: true } }));
    expect(dry).toMatch(/^STATE SAVED: no \(dry run/);
    expect(await readFile(join(dir, "state.json"), "utf8")).toBe(stateBefore);

    const bad = await client.callTool({ name: "digest_finish", arguments: { ...picks, following: [{ ref: "F42", gist: "x" }] } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/Unknown refs: F42\. Run .* has F1–F4, T1–T24, Y1–Y74\. .*Nothing was saved/);
    expect(await readFile(join(dir, "state.json"), "utf8")).toBe(stateBefore);

    const out = textOf(await client.callTool({ name: "digest_finish", arguments: picks }));
    expect(out).toMatch(/^STATE SAVED: 7 ids added \(0 already present\), 8 total, last_run \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\nCOUNTS: 4 new in Following · 4 read in full · 1 also new · 1 skipped · 1 unreadable\nWARNINGS: none\n/);
    const message = out.split(DIGEST_MARKER + "\n")[1]!;
    expect(message).toMatch(/^📰 \*\*Medium\*\* — 4 new in Following, 4 read in full \(since Tue, Sep 29, 6:00 AM MDT\)\n\n⭐ \*\*Read in full\*\*\n1\. \*\*Postgres vacuum, explained\*\*/);
    expect(message).toContain("_Also new_\n**Authors** (1) · [Post f00000000004]");
    expect(message).toMatch(/🗑 Skipped 1 as clickbait$/);

    const state = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
    expect(new Set(state.reported_posts)).toEqual(new Set([reportedId, hex("f", 1), hex("f", 2), hex("f", 3), hex("f", 4), hex("b", 1), hex("b", 25), hex("b", 26)]));
    const runFile = JSON.parse(await readFile(join(dir, "runs", (await readdir(join(dir, "runs")))[0]!), "utf8"));
    expect(state.last_run).toBe(runFile.started_at);
    expect(runFile.committed_at).toBeTruthy();

    // A second call changes nothing and shows the same digest.
    const stateAfter = await readFile(join(dir, "state.json"), "utf8");
    const again = textOf(await client.callTool({ name: "digest_finish", arguments: {} }));
    expect(again).toMatch(/^STATE SAVED: already saved at/);
    expect(again.split(DIGEST_MARKER + "\n")[1]).toBe(message);
    expect(await readFile(join(dir, "state.json"), "utf8")).toBe(stateAfter);

    const status = textOf(await client.callTool({ name: "digest_status", arguments: {} }));
    expect(status).toMatch(/State: last_run .* · 8 ids/);
    expect(status).toMatch(/committed .*7 ids added/);

    const mark = textOf(await client.callTool({ name: "mark_reported", arguments: { ids: ["https://medium.com/@x/a-post-abcdefabcdef", "F1", "nonsense"] } }));
    expect(mark).toMatch(/^Added 1 \(1 already present\)\. 9 ids\. last_run/);
    expect(mark).toContain("Not understood (skipped): nonsense");
  });

  it("falls back to no rating when the client can't sample, and stays under 40k for a huge day", async () => {
    await writeFile(join(dir, "interests.md"), INTERESTS);
    await writeFile(join(dir, "state.json"), JSON.stringify({ last_run: "2026-09-29T12:00:00Z", reported_posts: [] }, null, 2) + "\n");
    const longTitle = (id: string) => `${"A very long and descriptive headline about distributed systems ".repeat(2).slice(0, 117)} ${id.slice(-2)}`;
    const following = Array.from({ length: 400 }, (_, i) => recent(hex("f", i), { title: longTitle(hex("f", i)), collection: { id: "c", name: `Publication ${i % 30}`, slug: "p" } }));
    const forYou = Array.from({ length: 250 }, (_, i) => rawPost(hex("b", i), { title: longTitle(hex("b", i)) }));
    const { client } = await connect({ FollowingFeed: followingList(following), RecommendedFeed: forYouList(forYou), ReadingHistory: history([]) });

    const view = textOf(await client.callTool({ name: "digest_begin", arguments: { for_you_end: 250, following_max: 500 } }));
    expect(view.length).toBeLessThanOrEqual(40_000);
    expect(view).toContain("Rater: unavailable (the MCP client doesn't support sampling); nothing skipped");
    expect(view).toContain("Following: 400 new");
    // For you keeps its first 25 before Following is cut below 50.
    expect(view).toMatch(/\(F\d+–F400, Y26–Y225 omitted for size\)/);
    expect(view).toContain("\nY25 | ");

    const out = textOf(await client.callTool({ name: "digest_finish", arguments: {} }));
    expect(out).toContain("COUNTS: 400 new in Following · 0 read in full · 400 also new");
    expect(out.length).toBeLessThan(40_000);
    const state = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
    expect(state.reported_posts).toHaveLength(400);
  });

  it("says nothing is new on a quiet day and finishes with [SILENT]", async () => {
    const { client } = await connect({ FollowingFeed: followingList([]), RecommendedFeed: forYouList([]), ReadingHistory: history([]) });
    const view = textOf(await client.callTool({ name: "digest_begin", arguments: {} }));
    expect(view).toContain("Rater: off (nothing to rate); nothing skipped");
    expect(view).toMatch(/Nothing new\. Call digest_finish with no items\.$/);
    const out = textOf(await client.callTool({ name: "digest_finish", arguments: {} }));
    expect(out.endsWith(`${DIGEST_MARKER}\n[SILENT]`)).toBe(true);
    expect(JSON.parse(await readFile(join(dir, "state.json"), "utf8")).last_run).toMatch(/Z$/);
  });

  it("reports an expired session from digest_begin", async () => {
    process.env.MEDIUM_SID = "1:stale";
    process.env.MEDIUM_UID = "nobody";
    const { client } = await connect({});
    const r = await client.callTool({ name: "digest_begin", arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Authentication required/);
  });
});

describe("rate_headings", () => {
  it("rates through sampling, and is an error without it", async () => {
    const { client } = await connect({}, { sampling: true });
    const out = textOf(
      await client.callTool({
        name: "rate_headings",
        arguments: { items: [{ title: "I made $5k" }, { title: "Raft in practice" }], conditions: [{ name: "skip", definition: "money bait" }] },
      }),
    );
    expect(out).toBe("Rated 2 against: skip\n1. skip 90% (money bait) | I made $5k\n2. skip 10% (ok) | Raft in practice");
    const plain = await connect({});
    const r = await plain.client.callTool({ name: "rate_headings", arguments: { items: [{ title: "x" }], conditions: [{ name: "skip", definition: "d" }] } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/doesn't support sampling/);
  });
});
