import { describe, expect, it } from "vitest";
import { classifierFromEnv, JevClassifier, jevOptionsFromEnv, SamplingClassifier } from "../src/classifier/index.js";
import { RANK_LEVELS } from "../src/classifier/jev.js";
import { DRAFTING_RULES, isTrainLabel, labelSections, renderEvidence, type Evidence } from "../src/classifier/evidence.js";
import { proposalSummary, tidyProposal } from "../src/classifier/proposal.js";
import { parseProfile, splitSection } from "../src/classifier/types.js";

const PROFILE = {
  interests: "- Databases\n- AI engineering",
  skip: "Titles matching these patterns (by intent, not exact wording) are dropped entirely. A catchy title alone is not a reason to skip.\n- I tried N+ courses\n- Hustle-bro money posts",
};

type Body = { model: string; state: { reader: Record<string, unknown>; headline: Record<string, string> }; questions: Record<string, { type: string }> };

/** A fake Decisions API: "Postgres" titles are must-reads, "$" titles are skips, the rest are marginal. */
function fakeJev(opts: { status?: (n: number) => number; calls?: Body[] } = {}) {
  let n = 0;
  return (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Body;
    opts.calls?.push(body);
    const status = opts.status?.(n++) ?? 200;
    if (status !== 200) return new Response(status === 401 ? "bad key" : "busy", { status, headers: status === 429 ? { "retry-after": "0" } : {} });
    const t = body.state.headline.title!;
    const score = t.includes("Postgres") ? 2.9 : t.includes("$") ? 0.1 : 1;
    const answers: Record<string, unknown> = { importance: { type: "score", score, confidence: 0.9 } };
    if (body.questions.skip_ctx) answers.skip_ctx = { type: "noul", noul: t.includes("$") ? 0.95 : 0.05 };
    return new Response(JSON.stringify({ answers, usage: { cost: 0.00003 } }), { status: 200 });
  }) as unknown as typeof fetch;
}

const items = [{ title: "Postgres vacuum, explained", subtitle: "How autovacuum works" }, { title: "I made $10k in a month" }, { title: "Some other post", author: "Ann", publication: "Pub" }];

describe("parseProfile", () => {
  it("reads Interests and Skip sections, and treats a file without them as all interests", () => {
    expect(parseProfile("# Mine\n\n## Interests\n- Databases\n\n## Skip\n- Hustle posts\n\n## Notes\nignored")).toEqual({ interests: "- Databases", skip: "- Hustle posts" });
    expect(parseProfile("# Substack digest interests\n\n- Economics\n- AI research")).toEqual({ interests: "- Economics\n- AI research" });
    expect(parseProfile("")).toEqual({});
  });
});

describe("splitSection", () => {
  it("separates bullets from prose", () => {
    expect(splitSection(PROFILE.skip)).toEqual({
      bullets: ["I tried N+ courses", "Hustle-bro money posts"],
      prose: "Titles matching these patterns (by intent, not exact wording) are dropped entirely. A catchy title alone is not a reason to skip.",
    });
    expect(splitSection(undefined)).toEqual({ bullets: [], prose: "" });
  });
});

describe("JevClassifier", () => {
  it("sends the benchmarked request shape and maps answers to rank and skip", async () => {
    const calls: Body[] = [];
    const c = new JevClassifier({ apiKey: "k", fetch: fakeJev({ calls }) });
    const r = await c.classify(items, PROFILE);
    expect(r.unavailable).toBeUndefined();
    expect(r.verdicts[0]).toEqual({ rank: expect.closeTo(2.9 / 3, 5), skip: 0.05 });
    expect(r.verdicts[1]).toMatchObject({ skip: 0.95 });
    expect(r.verdicts[1]!.rank).toBeLessThan(0.1);
    expect(calls).toHaveLength(3);
    const body = calls.find((b) => b.state.headline.title === "Some other post")!;
    expect(body.model).toBe("typesafe/jev-1.13");
    expect(body.state.reader).toEqual({
      interests: ["Databases", "AI engineering"],
      skips: ["I tried N+ courses", "Hustle-bro money posts"],
      skip_note: "A catchy title alone is not a reason to skip.",
    });
    expect(body.state.headline).toEqual({ title: "Some other post", subtitle: "", author: "Ann", publication: "Pub" });
    expect(Object.keys(body.questions)).toEqual(["importance", "skip_ctx"]);
    expect((body.questions.importance as unknown as { criteria: string[] }).criteria).toEqual([...RANK_LEVELS]);
  });

  it("asks only for a rank when there's no Skip section", async () => {
    const calls: Body[] = [];
    const r = await new JevClassifier({ apiKey: "k", fetch: fakeJev({ calls }) }).classify(items.slice(0, 1), { interests: "- Databases" });
    expect(Object.keys(calls[0]!.questions)).toEqual(["importance"]);
    expect(r.verdicts[0]).toEqual({ rank: expect.any(Number) });
  });

  it("retries rate limits and server errors", async () => {
    const r = await new JevClassifier({ apiKey: "k", fetch: fakeJev({ status: (n) => (n < 2 ? 429 : n === 2 ? 503 : 200) }) }).classify(items, PROFILE);
    expect(r.verdicts.every(Boolean)).toBe(true);
    expect(r.notes).toEqual([]);
  });

  it("gives up at once on a bad key, and reports it as unavailable", async () => {
    const calls: Body[] = [];
    const r = await new JevClassifier({ apiKey: "bad", concurrency: 1, fetch: fakeJev({ status: () => 401, calls }) }).classify(items, PROFILE);
    expect(r.unavailable).toMatch(/openrouter\.ai refused the request \(HTTP 401: bad key\)/);
    expect(calls).toHaveLength(1);
  });

  it("keeps partial results and notes what failed", async () => {
    const r = await new JevClassifier({ apiKey: "k", concurrency: 1, fetch: fakeJev({ status: (n) => (n === 1 ? 400 : 200) }) }).classify(items, PROFILE);
    expect(r.verdicts.map(Boolean)).toEqual([true, false, true]);
    expect(r.notes).toEqual(["1 headlines unclassified (HTTP 400: busy)"]);
  });

  it("stops starting requests when the deadline is near", async () => {
    let clock = 0;
    const slow = (async (...args: Parameters<ReturnType<typeof fakeJev>>) => {
      clock += 5_000;
      return fakeJev()(...args);
    }) as unknown as typeof fetch;
    const many = Array.from({ length: 10 }, (_, i) => ({ title: `Post ${i}` }));
    const r = await new JevClassifier({ apiKey: "k", concurrency: 1, fetch: slow, now: () => clock }).classify(many, PROFILE, { deadline: 20_000 });
    expect(r.verdicts.filter(Boolean)).toHaveLength(4);
    expect(r.notes).toEqual(["time ran out; 6 headlines unclassified"]);
  });
});

describe("Jev endpoint settings", () => {
  it("defaults to OpenRouter, and takes any decisions-API endpoint, key and model from env", () => {
    expect(jevOptionsFromEnv("X", { OPENROUTER_API_KEY: "or" })).toEqual({ opts: { endpoint: "https://openrouter.ai/api/alpha/decisions", model: "typesafe/jev-1.13", apiKey: "or" } });
    expect(jevOptionsFromEnv("X", { X_JEV_API_KEY: "own", OPENROUTER_API_KEY: "or" })).toMatchObject({ opts: { apiKey: "own" } });
    expect(jevOptionsFromEnv("X", { X_JEV_URL: "http://localhost:8080/v1/systemone", X_JEV_MODEL: "jev-1.13" })).toEqual({ opts: { endpoint: "http://localhost:8080/v1/systemone", model: "jev-1.13" } });
    expect(jevOptionsFromEnv("X", {})).toEqual({ error: "X_CLASSIFIER=jev but neither X_JEV_API_KEY nor OPENROUTER_API_KEY is set" });
  });

  it("sends to the configured endpoint, without an Authorization header when there's no key", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      seen.push({ url, auth: init.headers.Authorization ?? null });
      return fakeJev()(url, init);
    }) as unknown as typeof fetch;
    const c = new JevClassifier({ endpoint: "http://jev.local:8080/v1/systemone", model: "jev-1.13", fetch: fetchImpl });
    expect(c.name).toBe("jev (jev-1.13 at jev.local:8080)");
    const r = await c.classify(items.slice(0, 1), PROFILE);
    expect(r.verdicts[0]).toMatchObject({ rank: expect.any(Number) });
    expect(seen).toEqual([{ url: "http://jev.local:8080/v1/systemone", auth: null }]);
    expect(new JevClassifier({ apiKey: "k" }).name).toBe("jev (typesafe/jev-1.13)");
  });
});

describe("classifierFromEnv", () => {
  it("defaults to sampling, picks jev with a key, and falls back without one", () => {
    expect(classifierFromEnv("X", null, {}).classifier).toBeInstanceOf(SamplingClassifier);
    const jev = classifierFromEnv("X", null, { X_CLASSIFIER: "jev", OPENROUTER_API_KEY: "k", X_JEV_MODEL: "typesafe/jev-1.14" });
    expect(jev.classifier.name).toBe("jev (typesafe/jev-1.14)");
    expect(jev.classifier.ranks).toBe(true);
    const missing = classifierFromEnv("X", null, { X_CLASSIFIER: "JEV" });
    expect(missing.classifier).toBeInstanceOf(SamplingClassifier);
    expect(missing.warning).toMatch(/neither X_JEV_API_KEY nor OPENROUTER_API_KEY is set/);
    expect(classifierFromEnv("X", null, { X_CLASSIFIER: "off" }).classifier.name).toBe("off");
    expect(classifierFromEnv("X", null, { X_CLASSIFIER: "magic" }).warning).toMatch(/isn't one of/);
  });
});

describe("interests evidence and proposals", () => {
  const ev = (n: number): Evidence => ({
    source: "Test",
    current: "## Interests\n- Databases\n\n## Skip\n- Hustle posts\n",
    sections: [
      { title: "History", strength: "weak", about: "clicked", items: Array.from({ length: n }, (_, i) => ({ title: `History post ${i}`, subtitle: "x".repeat(100), publication: i % 2 ? "Pub A" : "Pub B" })) },
      { title: "Saved", strength: "strong", about: "saved", items: Array.from({ length: n }, (_, i) => ({ title: `Saved post ${i}`, author: "Ann" })), total: n * 3 },
      { title: "Follows", strength: "strong", about: "follows", lines: ["A · B · C"], total: 3 },
    ],
    warnings: ["No negative evidence"],
    saveHint: "call save_interests_proposal",
  });

  it("renders strongest first, with rules, the current file, tallies and counts", () => {
    const t = renderEvidence(ev(5));
    expect(t).toContain(DRAFTING_RULES);
    expect(t).toContain("===== CURRENT interests.md =====\n## Interests\n- Databases");
    expect(t.indexOf("## Saved")).toBeLessThan(t.indexOf("## History"));
    expect(t).toContain("## Saved [STRONG: chosen deliberately] (5 of 15 shown)");
    expect(t).toContain("## Follows [STRONG: chosen deliberately] (3)\nfollows\nA · B · C");
    expect(t).toContain("Most frequent: Ann ×5");
    expect(t).toContain("Then: call save_interests_proposal");
    expect(t).toContain("Not available:\n- No negative evidence");
  });

  it("fits a budget by dropping weak subtitles first, then trimming the largest section for its strength", () => {
    const t = renderEvidence(ev(200), 12_000);
    expect(t.length).toBeLessThanOrEqual(12_000);
    expect(t).not.toContain("— xxxx"); // weak subtitles went first
    const shown = (name: string) => Number(t.match(new RegExp(`## ${name} \\[[^\\]]+\\] \\((\\d+) of`))?.[1]);
    expect(shown("Saved")).toBeGreaterThan(shown("History"));
  });

  it("splits labels into a fixed drafting half and test half", () => {
    const ids = Array.from({ length: 200 }, (_, i) => `id${i}`);
    const train = ids.filter(isTrainLabel);
    expect(train.length).toBeGreaterThan(70);
    expect(train.length).toBeLessThan(130);
    expect(isTrainLabel("id1")).toBe(isTrainLabel("id1"));
    const sections = labelSections(new Map([["a", "must"], ["b", "skip"], ["c", "meh"], ["d", "read"]]), new Map(["a", "b", "c", "d"].map((id) => [id, { title: `T ${id}` }])));
    expect(sections.map((s) => [s.title, s.strength, s.items!.map((i) => `${i.title}/${i.note}`)])).toEqual([
      ["Labelled must or read", "strong", ["T a/must", "T d/read"]],
      ["Labelled skip", "negative", ["T b/skip"]],
    ]);
  });

  it("tidies a proposal and summarizes what changed", () => {
    const t = tidyProposal("```markdown\n# Mine\n\n## Interests\n- Databases\n- Travel essays\n\n## Skip\n- Sports\n\n## Changes and why\n- added travel\n```");
    expect(t).toEqual({ ok: true, text: "# Mine\n\n## Interests\n- Databases\n- Travel essays\n\n## Skip\n- Sports\n" });
    expect(tidyProposal("Just some thoughts")).toMatchObject({ ok: false });
    const s = proposalSummary("## Interests\n- Databases\n\n## Skip\n- Hustle posts\n", (t as { text: string }).text);
    expect(s).toContain("Interests: 2 bullets (1 new, 0 removed, 1 kept)\n  + Travel essays");
    expect(s).toContain("Skip: 1 bullet (1 new, 1 removed, 0 kept)\n  + Sports\n  - Hustle posts");
  });
});
