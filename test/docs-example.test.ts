/**
 * Keeps docs/digest-tools.md honest. It runs one small, made-up digest through the
 * real tools (a fake Medium and a fake Jev), using the arguments printed in the doc,
 * and checks that every generated block in the doc matches what the tools return now,
 * and that each argument table lists exactly the tool's input fields.
 *
 * After changing a tool's output: UPDATE_DOCS=1 npx vitest run test/docs-example.test.ts
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { saveCredentials } from "../src/auth/credentials.js";
import { ClientProvider, createServer } from "../src/server.js";
import { asViewer, fakeMedium, forYouList, rawPost, SESSION, VIEWER, type GqlRequest, type Reply } from "./helpers.js";

const DOC = join(import.meta.dirname, "..", "docs", "digest-tools.md");
const NOW = new Date("2026-10-04T11:15:22Z");
const saved = { ...process.env };

beforeEach(async () => {
  process.env.MEDIUM_READER_HOME = await mkdtemp(join(tmpdir(), "medium-reader-"));
  process.env.MEDIUM_READER_DIGEST_DIR = await mkdtemp(join(tmpdir(), "medium-digest-"));
  process.env.MEDIUM_READER_DIGEST_TZ = "America/New_York";
  process.env.MEDIUM_READER_CLASSIFIER = "jev";
  process.env.MEDIUM_READER_JEV_API_KEY = "test-key";
  for (const k of ["MEDIUM_SID", "MEDIUM_UID", "MEDIUM_COOKIE", "MEDIUM_READER_DIGEST_RANK_FLOOR", "MEDIUM_READER_DIGEST_STYLE"]) delete process.env[k];
  await saveCredentials(SESSION);
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});
afterEach(() => {
  process.env = { ...saved };
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const INTERESTS = `## Interests
- Backend engineering: databases, distributed systems, performance work with real numbers
- AI engineering: agents, evaluation, LLMs in production
- Self-hosting and home labs

## Skip
- Income claims and get-rich-quick stories
`;

type Fake = { title: string; author: string; username: string; publication?: string; rank: number; skip: number; locked?: boolean; minutes?: number; claps?: number };

/** Every post in the example, with the rank and skip probability the fake Jev gives it. */
const POSTS: Record<string, Fake> = {
  a1: { title: "Postgres VACUUM, measured on a 2 TB table", author: "Ana Ruiz", username: "anaruiz", publication: "Better Databases", rank: 0.95, skip: 0.02, locked: true, minutes: 14, claps: 412 },
  a2: { title: "Evaluating agents without fooling yourself", author: "Sam Lee", username: "samlee", publication: "Applied AI Notes", rank: 0.91, skip: 0.03, minutes: 11, claps: 1280 },
  a3: { title: "My home lab runs on three mini PCs", author: "Jo Park", username: "jopark", rank: 0.72, skip: 0.05, minutes: 7, claps: 96 },
  a4: { title: "Ten morning habits of senior engineers", author: "Max Doe", username: "maxdoe", publication: "Career Lift", rank: 0.21, skip: 0.41, minutes: 4, claps: 2300 },
  a5: { title: "I made $12k in a month with AI side hustles", author: "Kim Cash", username: "kimcash", publication: "Career Lift", rank: 0.04, skip: 0.93, locked: true, minutes: 6, claps: 5100 },
  b1: { title: "Raft in 200 lines of Go", author: "Lena Ito", username: "lenaito", publication: "Systems Weekly", rank: 0.83, skip: 0.02, minutes: 18, claps: 3400 },
  b2: { title: "Why we left Kubernetes", author: "Omar Haddad", username: "ohaddad", rank: 0.66, skip: 0.06, locked: true, minutes: 9, claps: 7800 },
  c1: { title: "What the 2026 layoffs data actually shows", author: "Rae Quinn", username: "raequinn", publication: "Applied AI Notes", rank: 0.61, skip: 0.08, minutes: 12, claps: 640 },
  c2: { title: "The case for boring technology, revisited", author: "Ted Vos", username: "tedvos", rank: 0.55, skip: 0.04, minutes: 8, claps: 210 },
};
const ID: Record<string, string> = Object.fromEntries(Object.keys(POSTS).map((k, n) => [k, `${(0xd0c5e000 + n).toString(16)}0a1`]));
const REPORTED = "d0c5effff0a1";

function post(key: string) {
  const p = POSTS[key]!;
  const slug = p.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return rawPost(ID[key]!, {
    title: p.title,
    mediumUrl: `https://medium.com/@${p.username}/${slug}-${ID[key]}`,
    isLocked: Boolean(p.locked),
    firstPublishedAt: Date.UTC(2026, 9, 3, 18),
    readingTime: p.minutes ?? 5,
    clapCount: p.claps ?? 10,
    creator: { id: `u-${p.username}`, name: p.author, username: p.username },
    collection: p.publication ? { id: `c-${p.publication}`, name: p.publication, slug: p.publication.toLowerCase().replace(/ /g, "-") } : null,
    extendedPreviewContent: { subtitle: "" },
  });
}

/** A Jev-compatible decisions endpoint that answers from POSTS. */
const jevRequests: Array<{ state: { headline: { title: string } } }> = [];
function fakeJev(): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { state: { headline: { title: string } } };
    jevRequests.push(body);
    const p = Object.values(POSTS).find((x) => x.title === body.state.headline.title)!;
    return new Response(JSON.stringify({ answers: { importance: { type: "score", score: p.rank * 3 }, skip_ctx: { type: "noul", noul: p.skip } } }), { status: 200 });
  }) as unknown as typeof fetch;
}

const following = (): Reply => {
  const posts = ["a1", "a2", "a3", "a4", "a5"].map(post).concat(rawPost(REPORTED, { firstPublishedAt: Date.UTC(2026, 9, 3, 15) }));
  return { data: { followingFeed: { items: posts.map((p) => ({ reason: 1, postProviderExplanation: { reason: "PUBLISHED_BY_COLLECTION" }, post: p })), pagingInfo: { next: null } } } };
};

/** Positions 0–24 are top picks (two new, the rest already in Following); 25–27 are For you. */
const forYouPosts = [post("b1"), post("b2"), ...Array.from({ length: 23 }, (_, n) => post(["a1", "a2", "a3", "a4", "a5"][n % 5]!)), post("c1"), post("c2"), rawPost(REPORTED)];
const reasons = (i: number) => (i < 2 ? ["Because you follow Distributed Systems", "Selected for you"][i]! : i === 25 ? "From your network" : "Based on your reading history");

const history: Reply = {
  data: { viewer: { id: SESSION.uid, readingHistory: { postPreviewConnection: { postPreviews: [post("a2"), post("c1")].map((p) => ({ postId: p.id, post: p })), pagingInfo: { next: null } } } } },
};

const postReply = (req: GqlRequest): Reply => {
  const key = Object.keys(ID).find((k) => ID[k] === req.variables.id)!;
  return {
    data: {
      post: {
        ...post(key),
        wordCount: 2850,
        tags: [],
        viewerEdge: { fullContent: { isLockedPreviewOnly: false, bodyModel: { paragraphs: [
              { type: "P", text: "Autovacuum fell behind on our 2 TB orders table, and bloat reached 38% before anyone noticed." },
              { type: "H3", text: "What we measured" },
              { type: "P", text: "…" },
            ] } } },
      },
    },
  };
};

async function connect() {
  const { fetch } = fakeMedium({ Viewer: asViewer(VIEWER), FollowingFeed: following, RecommendedFeed: forYouList(forYouPosts, reasons), ReadingHistory: history, Post: postReply });
  vi.stubGlobal("fetch", fakeJev());
  const server = createServer(new ClientProvider(fetch));
  const client = new Client({ name: "docs", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

// ---- reading and writing the doc ----

/** `<!-- name -->` followed by a fenced block. */
function blocks(doc: string): Map<string, { full: string; body: string }> {
  const out = new Map<string, { full: string; body: string }>();
  for (const m of doc.matchAll(/<!-- (example|generated): ([\w-]+) -->\n(````?)(\w*)\n((?:(?!\3\n).*\n)*)\3\n/g)) out.set(`${m[1]}:${m[2]}`, { full: m[0], body: m[5]!.replace(/\n$/, "") });
  return out;
}

/** Field names in the table under `<!-- args: tool -->`. */
function argTable(doc: string, tool: string): string[] {
  const at = doc.indexOf(`<!-- args: ${tool} -->`);
  if (at < 0) throw new Error(`no args table for ${tool}`);
  const rows = doc.slice(at).split("\n").slice(1);
  const table = rows.slice(0, rows.findIndex((l, n) => n > 0 && !l.startsWith("|")));
  return table.slice(2).map((l) => /^\| `(\w+)`/.exec(l)?.[1] ?? l);
}

it("docs/digest-tools.md matches what the digest tools do", async () => {
  const dir = process.env.MEDIUM_READER_DIGEST_DIR!;
  await writeFile(join(dir, "interests.md"), INTERESTS);
  await writeFile(join(dir, "state.json"), JSON.stringify({ last_run: "2026-10-03T11:15:07Z", reported_posts: [REPORTED] }, null, 2) + "\n");

  let doc = await readFile(DOC, "utf8");
  const found = blocks(doc);
  const args = (name: string) => {
    const b = found.get(`example:${name}`);
    if (!b) throw new Error(`docs/digest-tools.md has no "<!-- example: ${name} -->" block`);
    return JSON.parse(b.body) as Record<string, unknown>;
  };

  const client = await connect();
  const call = async (name: string, a: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: a });
    const t = (r.content as Array<{ text: string }>)[0]!.text;
    if (r.isError) throw new Error(`${name} failed: ${t}`);
    return t;
  };
  const generated: Record<string, string> = {};
  generated.digest_begin = await call("digest_begin", args("digest_begin"));
  generated.jev_request = JSON.stringify(jevRequests.find((r) => r.state.headline.title === POSTS.a1!.title), null, 2);
  generated.read_post = await call("read_post", args("read_post"));
  generated.digest_finish = await call("digest_finish", args("digest_finish"));
  // The status line shows the temp directory and the file's real mtime; pin both so the doc is stable.
  generated.digest_status = (await call("digest_status", {}))
    .replace(dir, "/data/medium_digest")
    .replace(/state\.json written \S+/, `state.json written ${NOW.toISOString().replace(/\.\d+Z$/, "Z")}`);
  generated.mark_reported = await call("mark_reported", args("mark_reported"));

  if (process.env.UPDATE_DOCS) {
    for (const [name, text] of Object.entries(generated)) {
      const b = found.get(`generated:${name}`);
      if (!b) throw new Error(`docs/digest-tools.md has no "<!-- generated: ${name} -->" block`);
      const fence = text.includes("```") ? "````" : "```";
      doc = doc.replace(b.full, `<!-- generated: ${name} -->\n${fence}${name === "jev_request" ? "json" : "text"}\n${text}\n${fence}\n`);
    }
    await writeFile(DOC, doc);
  }

  // Argument tables list exactly the tool's input fields.
  const { tools } = await client.listTools();
  for (const tool of ["digest_begin", "read_post", "digest_finish", "mark_reported"]) {
    const schema = tools.find((t) => t.name === tool)!.inputSchema as { properties?: Record<string, unknown> };
    expect(argTable(doc, tool).sort(), `argument table for ${tool}`).toEqual(Object.keys(schema.properties ?? {}).sort());
  }

  if (!process.env.UPDATE_DOCS) {
    for (const [name, text] of Object.entries(generated)) {
      expect(found.get(`generated:${name}`)?.body, `generated block "${name}" is stale; run UPDATE_DOCS=1 npx vitest run test/docs-example.test.ts`).toBe(text);
    }
  }
});
