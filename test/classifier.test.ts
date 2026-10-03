import { describe, expect, it } from "vitest";
import { classifierFromEnv, JevClassifier, SamplingClassifier } from "../src/classifier/index.js";
import { RANK_LEVELS } from "../src/classifier/jev.js";
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
    expect(r.unavailable).toMatch(/OpenRouter refused the request \(HTTP 401: bad key\)/);
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

describe("classifierFromEnv", () => {
  it("defaults to sampling, picks jev with a key, and falls back without one", () => {
    expect(classifierFromEnv("X", null, {}).classifier).toBeInstanceOf(SamplingClassifier);
    const jev = classifierFromEnv("X", null, { X_CLASSIFIER: "jev", OPENROUTER_API_KEY: "k", X_JEV_MODEL: "typesafe/jev-1.14" });
    expect(jev.classifier.name).toBe("jev (typesafe/jev-1.14)");
    expect(jev.classifier.ranks).toBe(true);
    const missing = classifierFromEnv("X", null, { X_CLASSIFIER: "JEV" });
    expect(missing.classifier).toBeInstanceOf(SamplingClassifier);
    expect(missing.warning).toMatch(/OPENROUTER_API_KEY isn't set/);
    expect(classifierFromEnv("X", null, { X_CLASSIFIER: "off" }).classifier.name).toBe("off");
    expect(classifierFromEnv("X", null, { X_CLASSIFIER: "magic" }).warning).toMatch(/isn't one of/);
  });
});

