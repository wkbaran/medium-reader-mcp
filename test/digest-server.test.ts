import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  vi.unstubAllGlobals();
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
    expect(view).toContain("Classifier sampling: 1 skipped (threshold 70%)");
    expect(view).toContain("You read: @fav ×1");
    expect(view).toContain("Interests:\n- Databases");
    expect(view).toMatch(/\nF1 \| Postgres vacuum, explained \| Fav Author \| - \| 4 \| 10 \| R\n/);
    expect(view).toContain("## Skipped by classifier\nF2 I made $10k in a month");
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
    expect(view).toContain("Classifier sampling: unavailable (the MCP client doesn't support sampling); nothing skipped");
    expect(view).toContain("Following: 400 new");
    // For you keeps its first 25 before Following is cut below 50.
    expect(view).toMatch(/\(F\d+–F400, Y26–Y225 omitted for size\)/);
    expect(view).toContain("\nY25 | ");

    // Naming nothing while the work list showed posts is refused until the sections are declared empty.
    const refused = await client.callTool({ name: "digest_finish", arguments: {} });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/following: \d+ listed, none named .*for_you: 25 listed, none named \(best: Y1, .*Nothing was saved/);
    expect(JSON.parse(await readFile(join(dir, "state.json"), "utf8")).reported_posts).toHaveLength(0);
    const out = textOf(await client.callTool({ name: "digest_finish", arguments: { empty_sections: ["following", "top_picks", "for_you"] } }));
    expect(out).toContain("COUNTS: 400 new in Following · 0 read in full · 400 also new");
    expect(out.length).toBeLessThan(40_000);
    const state = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
    expect(state.reported_posts).toHaveLength(400);
  });

  it("ranks with Jev: sorts each section best first, applies the rank floor, and still commits everything", async () => {
    process.env.MEDIUM_READER_CLASSIFIER = "jev";
    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.MEDIUM_READER_DIGEST_RANK_FLOOR = "0.2";
    const sent: string[] = [];
    // Global fetch is only Jev here; Medium goes through the injected fake.
    vi.stubGlobal("fetch", async (url: string, init: { body: string; headers: Record<string, string> }) => {
      expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
      expect(init.headers.Authorization).toBe("Bearer test-key");
      const t = JSON.parse(init.body).state.headline.title as string;
      sent.push(t);
      const score = t.includes("Postgres") ? 3 : t.includes("Kafka") ? 2 : t.includes("$") ? 0 : t.includes("Horoscope") ? 0.3 : 1.2;
      return new Response(JSON.stringify({ answers: { importance: { type: "score", score }, skip_ctx: { type: "noul", noul: t.includes("$") ? 0.9 : 0.1 } } }));
    });
    await writeFile(join(dir, "interests.md"), INTERESTS);
    await writeFile(join(dir, "state.json"), JSON.stringify({ last_run: "2026-09-29T12:00:00Z", reported_posts: [] }, null, 2) + "\n");
    const following = [
      recent(hex("f", 1), { title: "Your Horoscope for Tuesday" }),
      recent(hex("f", 2), { title: "Kafka consumer lag, measured" }),
      recent(hex("f", 3), { title: "I made $10k in a month" }),
      recent(hex("f", 4), { title: "Postgres vacuum, explained" }),
      recent(hex("f", 5), { title: "Something in between" }),
    ];
    const { client } = await connect({ FollowingFeed: followingList(following), RecommendedFeed: forYouList([]), ReadingHistory: history([]) });

    const view = textOf(await client.callTool({ name: "digest_begin", arguments: {} }));
    expect(sent).toHaveLength(5);
    expect(view).toContain("Classifier jev (typesafe/jev-1.13): 5 ranked · 1 skipped (threshold 70%) · 1 below rank floor 20%");
    expect(view).toContain("Columns: ref | rank (0–100");
    // Best first; the skip and the below-floor post are out of the table.
    expect(view).toMatch(/## Following\nF4 \| 100 \| Postgres vacuum, explained .*\nF2 \| 67 \| Kafka .*\nF5 \| 40 \| Something in between/);
    expect(view).toContain("## Skipped by classifier\nF3 I made $10k in a month");
    expect(view).toContain("## Ranked below 20 (still valid refs)\nF1 Your Horoscope for Tuesday");
    expect(view).not.toMatch(/\nF1 \|/);
    expect(view).toContain("rows are best-ranked first");

    const out = textOf(await client.callTool({ name: "digest_finish", arguments: { starred: [{ ref: "F4", gist: "Vacuum.", why: "Depth." }], following: [{ ref: "F1", gist: "Picked anyway." }] } }));
    expect(out).toContain("COUNTS: 5 new in Following · 2 read in full · 2 also new · 1 skipped · 0 unreadable");
    const runFile = JSON.parse(await readFile(join(dir, "runs", (await readdir(join(dir, "runs")))[0]!), "utf8"));
    expect(runFile.rater).toMatchObject({ status: "ok", classifier: "jev (typesafe/jev-1.13)", ranked: 5, skipped: 1, floor: 0.2, low: 1 });
    expect(runFile.items.find((i: { ref: string }) => i.ref === "F4").rank).toBe(1);
    const status = textOf(await client.callTool({ name: "digest_status", arguments: {} }));
    expect(status).toContain("classifier jev (typesafe/jev-1.13) · rank floor 20%");
  });

  it("in exclude mode, leaves posts below the rank floor out of the work list and the digest, and still commits them", async () => {
    process.env.MEDIUM_READER_CLASSIFIER = "jev";
    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.MEDIUM_READER_DIGEST_RANK_FLOOR = "0.5";
    process.env.MEDIUM_READER_DIGEST_RANK_FLOOR_MODE = "exclude";
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const t = JSON.parse(init.body).state.headline.title as string;
      const score = t.includes("Postgres") ? 3 : t.includes("Kafka") ? 2 : t.includes("$") ? 0 : t.includes("Horoscope") ? 0.3 : 1.2;
      return new Response(JSON.stringify({ answers: { importance: { type: "score", score }, skip_ctx: { type: "noul", noul: t.includes("$") ? 0.9 : 0.1 } } }));
    });
    await writeFile(join(dir, "interests.md"), INTERESTS);
    await writeFile(join(dir, "state.json"), JSON.stringify({ last_run: "2026-09-29T12:00:00Z", reported_posts: [] }, null, 2) + "\n");
    const following = [
      recent(hex("f", 1), { title: "Your Horoscope for Tuesday" }),
      recent(hex("f", 2), { title: "Kafka consumer lag, measured" }),
      recent(hex("f", 3), { title: "I made $10k in a month" }),
      recent(hex("f", 4), { title: "Postgres vacuum, explained" }),
      recent(hex("f", 5), { title: "Something in between" }),
    ];
    const { client } = await connect({ FollowingFeed: followingList(following), RecommendedFeed: forYouList([]), ReadingHistory: history([]) });

    const view = textOf(await client.callTool({ name: "digest_begin", arguments: {} }));
    expect(view).toContain("Classifier jev (typesafe/jev-1.13): 5 ranked · 1 skipped (threshold 70%) · 2 below rank floor 50% (left out)");
    expect(view).toMatch(/## Following\nF4 \| 100 \| Postgres .*\nF2 \| 67 \| Kafka .*\n/);
    expect(view).not.toContain("Ranked below");
    expect(view).not.toContain("Horoscope");
    expect(view).not.toContain("Something in between");

    const out = textOf(await client.callTool({ name: "digest_finish", arguments: { starred: [{ ref: "F4", gist: "Vacuum.", why: "Depth." }], following: [{ ref: "F2", gist: "Lag." }] } }));
    expect(out).toContain("COUNTS: 5 new in Following · 2 read in full · 0 also new · 1 skipped · 0 unreadable");
    const message = out.slice(out.indexOf(DIGEST_MARKER) + DIGEST_MARKER.length + 1);
    expect(message).toContain("🔽 Left out 2 ranked below 50");
    expect(message).not.toContain("Horoscope");
    expect(message).not.toContain("Also new");
    expect(JSON.parse(await readFile(join(dir, "state.json"), "utf8")).reported_posts).toHaveLength(5);
    const runFile = JSON.parse(await readFile(join(dir, "runs", (await readdir(join(dir, "runs")))[0]!), "utf8"));
    expect(runFile.rater).toMatchObject({ floor: 0.5, low: 2, floor_mode: "exclude" });
    expect(textOf(await client.callTool({ name: "digest_status", arguments: {} }))).toContain("rank floor 50% (exclude)");
  });

  it("refuses a finish that forgets a listed section, ignoring posts below the floor, until it's declared empty", async () => {
    process.env.MEDIUM_READER_CLASSIFIER = "jev";
    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.MEDIUM_READER_DIGEST_RANK_FLOOR = "0.5";
    process.env.MEDIUM_READER_DIGEST_RANK_FLOOR_MODE = "exclude";
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const t = JSON.parse(init.body).state.headline.title as string;
      const score = t.includes("Postgres") ? 3 : t.includes("Security") ? 2.8 : 0.3;
      return new Response(JSON.stringify({ answers: { importance: { type: "score", score }, skip_ctx: { type: "noul", noul: 0.1 } } }));
    });
    await writeFile(join(dir, "interests.md"), INTERESTS);
    await writeFile(join(dir, "state.json"), JSON.stringify({ last_run: "2026-09-29T12:00:00Z", reported_posts: [] }, null, 2) + "\n");
    // For you starts at position 25, so pad the first 25.
    const forYou = [...Array.from({ length: 25 }, (_, i) => rawPost(hex("c", i))), rawPost(hex("b", 1), { title: "Horoscope" }), rawPost(hex("b", 2), { title: "Security practices that backfire" })];
    const { client } = await connect({ FollowingFeed: followingList([recent(hex("f", 1), { title: "Postgres vacuum" })]), RecommendedFeed: forYouList(forYou), ReadingHistory: history([]) });
    const view = textOf(await client.callTool({ name: "digest_begin", arguments: {} }));
    const y = view.match(/\n(Y\d+) \| 93 \| Security/)![1]!;

    const following = [{ ref: "F1", gist: "Vacuum." }];
    const refused = await client.callTool({ name: "digest_finish", arguments: { following } });
    expect(refused.isError).toBe(true);
    // Only the ranked-up post counts; the one below the floor was never listed.
    expect(textOf(refused)).toContain(`for_you: 1 listed, none named (best: ${y} (93))`);
    expect(textOf(refused)).not.toContain("following:");
    expect(JSON.parse(await readFile(join(dir, "state.json"), "utf8")).reported_posts).toHaveLength(0);

    const out = textOf(await client.callTool({ name: "digest_finish", arguments: { following, empty_sections: '["for_you", "following", "bogus"]' } }));
    expect(out).toMatch(/^STATE SAVED: 1 ids added/);
    expect(out).toContain('WARNINGS: empty_sections: "bogus" isn\'t a section (following, top_picks, for_you); ignored. following is in empty_sections but has picks; kept the picks.');
  });

  it("falls back to sampling when Jev is chosen without a key, and says so", async () => {
    process.env.MEDIUM_READER_CLASSIFIER = "jev";
    delete process.env.OPENROUTER_API_KEY;
    await writeFile(join(dir, "interests.md"), INTERESTS);
    await writeFile(join(dir, "state.json"), JSON.stringify({ last_run: "2026-09-29T12:00:00Z", reported_posts: [] }, null, 2) + "\n");
    const { client } = await connect({ FollowingFeed: followingList([recent(hex("f", 1))]), RecommendedFeed: forYouList([]), ReadingHistory: history([]) }, { sampling: true });
    const view = textOf(await client.callTool({ name: "digest_begin", arguments: {} }));
    expect(view).toContain("Classifier sampling: 0 skipped");
    expect(view).toContain("MEDIUM_READER_CLASSIFIER=jev but neither MEDIUM_READER_JEV_API_KEY nor OPENROUTER_API_KEY is set; used sampling.");
  });

  it("continues an open run instead of starting another, until it is stale, finished or given a since", async () => {
    await writeFile(join(dir, "state.json"), JSON.stringify({ last_run: "2026-09-29T12:00:00Z", reported_posts: [] }, null, 2) + "\n");
    const following = [recent(hex("f", 1), { title: "Postgres vacuum, explained" }), recent(hex("f", 2))];
    const forYou = Array.from({ length: 120 }, (_, i) => rawPost(hex("b", i)));
    const { client, requests } = await connect({ FollowingFeed: followingList(following), RecommendedFeed: forYouList(forYou), ReadingHistory: history([]) });
    const begin = () => client.callTool({ name: "digest_begin", arguments: {} });
    const runs = async () => (await readdir(join(dir, "runs"))).sort();

    const first = textOf(await begin());
    const runId = first.match(/^Medium digest run (\S+)/)![1]!;
    const fetched = requests.length;
    expect(first).toContain("Next: shortlist");

    // a second begin (a retry, or a subagent) gets the same run, fetches nothing and is not told to finish
    const second = textOf(await begin());
    expect(requests.length).toBe(fetched);
    expect(await runs()).toEqual([`${runId}.json`]);
    expect(second).toContain(`Continuing the open digest run ${runId}`);
    expect(second).toContain(`Medium digest run ${runId}`);
    expect(second).toContain("\nF1 | Postgres vacuum, explained |");
    expect(second).not.toContain("Next: shortlist");

    // an explicit since asks for a new run
    const forced = textOf(await client.callTool({ name: "digest_begin", arguments: { since: "2026-09-28T00:00:00Z" } }));
    expect(forced).not.toContain("Continuing");
    expect(await runs()).toHaveLength(2);
    const forcedId = forced.match(/^Medium digest run (\S+)/)![1]!;

    // a run that started 90 minutes ago or more is stale and is replaced
    const file = join(dir, "runs", `${forcedId}.json`);
    const run = JSON.parse(await readFile(file, "utf8"));
    run.started_at = new Date(Date.now() - 91 * 60_000).toISOString().replace(/\.\d+Z$/, "Z");
    await writeFile(file, JSON.stringify(run));
    expect(textOf(await begin())).not.toContain("Continuing");
    expect(await runs()).toHaveLength(3);

    // once the run is finished, the next begin starts a new one
    expect(textOf(await client.callTool({ name: "digest_finish", arguments: { following: [{ ref: "F1", gist: "x" }], empty_sections: ["top_picks", "for_you"] } }))).toContain("STATE SAVED");
    expect(textOf(await begin())).not.toContain("Continuing");
    expect(await runs()).toHaveLength(4);
  });

  it("says nothing is new on a quiet day and finishes with [SILENT]", async () => {
    const { client } = await connect({ FollowingFeed: followingList([]), RecommendedFeed: forYouList([]), ReadingHistory: history([]) });
    const view = textOf(await client.callTool({ name: "digest_begin", arguments: {} }));
    expect(view).toContain("Classifier sampling: off (nothing to rate); nothing skipped");
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

describe("interests tools", () => {
  it("gathers evidence from lists, follows, digest picks, labels and history, and saves a proposal beside interests.md", async () => {
    await writeFile(join(dir, "interests.md"), INTERESTS);
    await mkdir(join(dir, "runs"), { recursive: true });
    await writeFile(
      join(dir, "runs", "20261001T120000Z.json"),
      JSON.stringify({ items: [{ ref: "F1", id: "aa", title: "Postgres at scale", publication: "Big Pub" }], judgments: { starred: [{ ref: "F1", gist: "", why: "" }] } }),
    );
    await mkdir(join(dir, "classifier"), { recursive: true });
    await writeFile(join(dir, "classifier", "dataset.jsonl"), ['{"id":"x1","title":"Run club changed my life"}', '{"id":"x2","title":"Kafka lag, measured"}'].join("\n") + "\n");
    await writeFile(join(dir, "classifier", "labels.jsonl"), ['{"id":"x1","label":"skip"}', '{"id":"x2","label":"must"}'].join("\n") + "\n");
    const { client } = await connect({
      ReadingList: { data: { getPredefinedCatalog: { id: "rl", itemsConnection: { paging: { count: 1 } } } } },
      Lists: { data: { catalogsByUser: { catalogs: [], paging: { nextPageCursor: null } } } },
      ReadingListItems: { data: { getPredefinedCatalog: { itemsConnection: { items: [{ entity: { __typename: "Post", ...rawPost(hex("a", 1), { title: "Saved: Java virtual threads" }) } }], paging: { count: 1 } } } } },
      FollowCounts: { data: { userResult: { socialStats: { collectionFollowingCount: 2 } } } },
      FollowingPublications: { data: { userResult: { followingCollectionConnection: { collections: [{ id: "c1", name: "Javarevisited", slug: "javarevisited" }, { id: "c2", name: "ITNEXT", slug: "itnext" }] } } } },
      ReadingHistory: history([rawPost(hex("e", 1), { title: "Read: Kubernetes autoscaling" })]),
    });

    const ev = textOf(await client.callTool({ name: "interests_evidence", arguments: {} }));
    expect(ev).toMatch(/^INTERESTS EVIDENCE · Medium/);
    expect(ev).toContain("===== CURRENT interests.md =====\n# Interests file");
    expect(ev).toMatch(/## Saved to reading lists \[STRONG[^\]]*\] \(1\)\n.*\n- Saved: Java virtual threads/);
    expect(ev).toContain("## Followed publications [STRONG: chosen deliberately] (2)");
    expect(ev).toContain("Javarevisited · ITNEXT");
    expect(ev).toContain("- Postgres at scale (Big Pub)");
    expect(ev).toContain("- Kafka lag, measured [must]");
    expect(ev).toContain("- Run club changed my life [skip]");
    expect(ev).toContain("- Read: Kubernetes autoscaling");
    expect(ev).toContain("call save_interests_proposal");

    const bad = await client.callTool({ name: "save_interests_proposal", arguments: { text: "I think you like Java." } });
    expect(bad.isError).toBe(true);
    const saved = textOf(await client.callTool({ name: "save_interests_proposal", arguments: { text: "## Interests\n- Databases\n- Java concurrency\n\n## Skip\n- Self-help challenges\n\nChanges and why\n- more Java" } }));
    expect(saved).toContain("interests.md is unchanged.");
    expect(saved).toContain("  + Java concurrency");
    expect(await readFile(join(dir, "interests.proposed.md"), "utf8")).toBe("## Interests\n- Databases\n- Java concurrency\n\n## Skip\n- Self-help challenges\n");
    expect(await readFile(join(dir, "interests.md"), "utf8")).toBe(INTERESTS);
  });

  it("offers evidence without a digest directory, but not saving", async () => {
    delete process.env.MEDIUM_READER_DIGEST_DIR;
    const { client } = await connect({});
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("interests_evidence");
    expect(names).not.toContain("save_interests_proposal");
  });
});
