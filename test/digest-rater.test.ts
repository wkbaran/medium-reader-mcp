import { describe, expect, it } from "vitest";
import { parseInterests } from "../src/digest/interests.js";
import { buildPrompt, parseRatings, SamplingRater, skipCondition, type SampleFn } from "../src/classifier/sampling.js";

const INTERESTS = `# Medium digest interests

## Interests
- Backend engineering: databases

## Skip
Titles matching these patterns are dropped.
- I tried N+ courses/tools/books …
- Anything about earning money or passive income
`;

const condition = skipCondition(parseInterests(INTERESTS))!;
const items = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `Title ${i + 1}`, author: "A" }));

/** A fake model: rates titles containing "$" as skip, from the numbered list in the prompt. */
function fakeModel(calls: string[] = []): SampleFn {
  return async ({ prompt }) => {
    calls.push(prompt);
    const lines = prompt.split("\n").filter((l) => /^\d+\. /.test(l));
    return JSON.stringify(lines.map((l) => ({ i: Number(l.split(".")[0]), skip: l.includes("$") ? 0.95 : 0.05, skip_why: l.includes("$") ? "money" : "fine" })));
  };
}

describe("interests", () => {
  it("parses the Interests and Skip sections", () => {
    const i = parseInterests(INTERESTS);
    expect(i.interests).toBe("- Backend engineering: databases");
    expect(i.skip).toMatch(/^Titles matching.*\n- I tried N\+.*\n- Anything about earning money/s);
    expect(skipCondition({ interests: "x" })).toBeNull();
    expect(skipCondition(null)).toBeNull();
  });
});

describe("buildPrompt", () => {
  it("puts the Skip definitions, the interests and every numbered title in the prompt", () => {
    const p = buildPrompt([{ title: "I made $10k", subtitle: "how", author: "Ann", publication: "Pub" }], [condition]);
    expect(p).toContain("I tried N+ courses/tools/books");
    expect(p).toContain("passive income");
    expect(p).toContain("Backend engineering: databases");
    expect(p).toContain("1. I made $10k (subtitle: how; by Ann; in Pub)");
    expect(p).toContain('"skip_why"');
  });
});

describe("parseRatings", () => {
  const c = [condition];
  it("reads plain JSON, fenced JSON, JSON inside prose, and wrapped arrays", () => {
    const want = [{ skip: { confidence: 0.9, reason: "money" } }, { skip: { confidence: 0.1 } }];
    const body = '[{"i":1,"skip":0.9,"skip_why":"money"},{"i":2,"skip":0.1}]';
    expect(parseRatings(body, 2, c)).toEqual(want);
    expect(parseRatings("```json\n" + body + "\n```", 2, c)).toEqual(want);
    expect(parseRatings(`<think>hmm [1]</think>Sure! Here you go: ${body} Hope that helps.`, 2, c)).toEqual(want);
    expect(parseRatings(`{"ratings": ${body}}`, 2, c)).toEqual(want);
  });

  it("accepts percentages, numeric strings and nested verdicts; ignores out-of-range indexes", () => {
    const r = parseRatings('[{"i":1,"skip":"85%"},{"i":2,"skip":{"confidence":40,"reason":"meh"}},{"i":9,"skip":1}]', 2, c);
    expect(r).toEqual([{ skip: { confidence: 0.85 } }, { skip: { confidence: 0.4, reason: "meh" } }]);
  });

  it("returns null for garbage", () => {
    expect(parseRatings("I can't help with that.", 2, c)).toBeNull();
    expect(parseRatings('[{"i":1,"other":0.9}]', 2, c)).toBeNull();
    expect(parseRatings("[1, 2", 2, c)).toBeNull();
  });
});

describe("SamplingRater", () => {
  it("rates in batches and keeps order", async () => {
    const calls: string[] = [];
    const list = items(90);
    list[50] = { title: "I made $5k with passive income", author: "A" };
    const r = await new SamplingRater(fakeModel(calls), { batchSize: 40 }).rate(list, [condition]);
    expect(calls).toHaveLength(3);
    expect(r.unavailable).toBeUndefined();
    expect(r.notes).toEqual([]);
    expect(r.ratings[50]).toEqual({ skip: { confidence: 0.95, reason: "money" } });
    expect(r.ratings[0]!.skip!.confidence).toBe(0.05);
    expect(r.ratings.every(Boolean)).toBe(true);
  });

  it("fails open when the client has no sampling", async () => {
    const r = await new SamplingRater(null).rate(items(3), [condition]);
    expect(r.unavailable).toMatch(/doesn't support sampling/);
    expect(r.ratings).toEqual([null, null, null]);
  });

  it("fails open when every request throws or returns garbage", async () => {
    const boom = await new SamplingRater(async () => {
      throw new Error("Sampling rate limit exceeded");
    }).rate(items(3), [condition]);
    expect(boom.unavailable).toMatch(/rate limit/);
    const junk = await new SamplingRater(async () => "no idea").rate(items(3), [condition]);
    expect(junk.unavailable).toMatch(/wasn't the requested JSON/);
    expect(junk.ratings).toEqual([null, null, null]);
  });

  it("keeps a batch unrated when its request times out, and rates the rest", async () => {
    let n = 0;
    const model = fakeModel();
    const sample: SampleFn = (req) => (++n === 1 ? new Promise(() => {}) : model(req));
    const r = await new SamplingRater(sample, { batchSize: 2, requestTimeoutMs: 20 }).rate(items(4), [condition]);
    expect(r.ratings.slice(0, 2)).toEqual([null, null]);
    expect(r.ratings[2]).not.toBeNull();
    expect(r.notes.join()).toMatch(/titles 1–2 unrated \(no reply within/);
  });

  it("stops when the time budget runs out and keeps the rest unrated", async () => {
    let clock = 0;
    const model = fakeModel();
    const sample: SampleFn = async (req) => {
      clock += 60_000;
      return model(req);
    };
    const r = await new SamplingRater(sample, { batchSize: 10, now: () => clock }).rate(items(50), [condition], { deadline: 124_000 });
    // Batches start at t=0, 60s and 120s; the third would have only 4s left, so it doesn't start.
    expect(r.ratings.filter(Boolean)).toHaveLength(20);
    expect(r.notes).toEqual(["time ran out; 30 titles unrated"]);
  });
});
