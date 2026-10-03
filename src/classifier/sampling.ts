/**
 * The sampling backend: rates headlines with the MCP client's own model through
 * MCP sampling (`sampling/createMessage`), so it needs no key and costs nothing
 * extra, but it is as slow as that model and its confidences are coarse.
 *
 * `SamplingRater` is the general engine (named conditions → a confidence each),
 * also behind the `rate_headings` tool. `SamplingClassifier` adapts it to the
 * `Classifier` interface: it decides the `skip` condition only and doesn't rank.
 */
import type { Classifier, ClassifyResult, Headline, ReaderProfile } from "./types.js";

export type RateItem = Headline;

export interface Condition {
  /** Short identifier, used as a JSON key: letters, digits, `_` or `-`. */
  name: string;
  /** How to decide it, in plain words. */
  definition: string;
}

export interface Verdict {
  /** 0–1. */
  confidence: number;
  reason?: string;
}

/** Per item, per condition name; `null` when the item wasn't rated. */
export type ItemRating = Record<string, Verdict> | null;

export interface RateResult {
  ratings: ItemRating[];
  /** Set when nothing could be rated (no sampling support, every request failed). */
  unavailable?: string;
  /** Partial failures: batches that failed or weren't attempted. */
  notes: string[];
}

export interface TitleRater {
  rate(items: readonly RateItem[], conditions: readonly Condition[], opts?: { deadline?: number }): Promise<RateResult>;
}

/** One model request: returns the model's text. */
export type SampleFn = (req: { systemPrompt: string; prompt: string; maxTokens: number; timeoutMs: number }) => Promise<string>;

export interface SamplingRaterOptions {
  batchSize?: number;
  /** Upper bound for one request. */
  requestTimeoutMs?: number;
  /** Don't start a batch with less than this much of the deadline left. */
  minBatchMs?: number;
  maxTokens?: number;
  now?: () => number;
}

const SYSTEM_PROMPT =
  "You classify Medium post headlines. For every numbered headline and every condition, give your confidence (0 to 1) that the condition holds, " +
  "and a reason of at most 8 words. Reply with JSON only, no prose and no code fences.";

/** Rates headlines through MCP sampling (`sampling/createMessage`), so the MCP client's model does the work. */
export class SamplingRater implements TitleRater {
  private readonly batchSize: number;
  private readonly requestTimeoutMs: number;
  private readonly minBatchMs: number;
  private readonly maxTokens: number;
  private readonly now: () => number;

  /** `sample` is null when the client doesn't support sampling. */
  constructor(
    private readonly sample: SampleFn | null,
    opts: SamplingRaterOptions = {},
  ) {
    this.batchSize = opts.batchSize ?? 40;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 120_000;
    this.minBatchMs = opts.minBatchMs ?? 5_000;
    this.maxTokens = opts.maxTokens ?? 4096;
    this.now = opts.now ?? Date.now;
  }

  async rate(items: readonly RateItem[], conditions: readonly Condition[], opts: { deadline?: number } = {}): Promise<RateResult> {
    const ratings: ItemRating[] = items.map(() => null);
    if (!items.length || !conditions.length) return { ratings, notes: [] };
    if (!this.sample) return { ratings, unavailable: "the MCP client doesn't support sampling", notes: [] };

    const notes: string[] = [];
    const errors: string[] = [];
    let attempted = 0;
    let succeeded = 0;
    for (let start = 0; start < items.length; start += this.batchSize) {
      const batch = items.slice(start, start + this.batchSize);
      const left = opts.deadline === undefined ? Infinity : opts.deadline - this.now();
      if (left < this.minBatchMs) {
        notes.push(`time ran out; ${items.length - start} titles unrated`);
        break;
      }
      attempted++;
      const timeoutMs = Math.max(1, Math.min(this.requestTimeoutMs, left));
      try {
        const text = await withTimeout(
          this.sample({ systemPrompt: SYSTEM_PROMPT, prompt: buildPrompt(batch, conditions), maxTokens: this.maxTokens, timeoutMs }),
          timeoutMs,
        );
        const parsed = parseRatings(text, batch.length, conditions);
        if (!parsed) throw new Error("the reply wasn't the requested JSON");
        parsed.forEach((r, i) => (ratings[start + i] = r));
        succeeded++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(msg);
        notes.push(`titles ${start + 1}–${start + batch.length} unrated (${short(msg)})`);
      }
    }
    if (attempted > 0 && succeeded === 0) return { ratings, unavailable: short(errors[0] ?? "no reply"), notes: [] };
    if (attempted === 0) return { ratings, unavailable: "no time left to rate", notes: [] };
    return { ratings, notes };
  }
}

export function buildPrompt(items: readonly RateItem[], conditions: readonly Condition[]): string {
  const conds = conditions.map((c) => `- ${c.name}: ${c.definition}`).join("\n");
  const lines = items.map((it, i) => {
    const extra = [it.subtitle ? `subtitle: ${it.subtitle}` : null, it.author ? `by ${it.author}` : null, it.publication ? `in ${it.publication}` : null]
      .filter(Boolean)
      .join("; ");
    return `${i + 1}. ${it.title}${extra ? ` (${extra})` : ""}`;
  });
  const example = Object.fromEntries([["i", 1], ...conditions.flatMap((c) => [[c.name, 0.1], [`${c.name}_why`, "short reason"]])]);
  return [
    "Conditions:",
    conds,
    "",
    "Headlines:",
    ...lines,
    "",
    `Reply with a JSON array with one object per headline, in order, like ${JSON.stringify([example])}. ` +
      `"i" is the headline number; each condition gets a confidence from 0 to 1 and a reason of at most 8 words.`,
  ].join("\n");
}

/**
 * Pull ratings out of a model reply. Tolerates code fences, <think> blocks,
 * text around the JSON, `{ "ratings": [...] }` wrappers, percentages and
 * numeric strings. Returns null when nothing usable is there.
 */
export function parseRatings(text: string, count: number, conditions: readonly Condition[]): ItemRating[] | null {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?/gi, "");
  const value = extractJson(cleaned);
  if (value === undefined) return null;
  const list: unknown[] | null = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? (Object.values(value as Record<string, unknown>).find(Array.isArray) as unknown[] | undefined) ?? null
      : null;
  if (!list) return null;
  const out: ItemRating[] = Array.from({ length: count }, () => null);
  let any = false;
  list.forEach((entry, pos) => {
    if (!entry || typeof entry !== "object") return;
    const e = entry as Record<string, unknown>;
    const idx = Number(e.i ?? e.index ?? e.n ?? pos + 1) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= count) return;
    const rating: Record<string, Verdict> = {};
    for (const c of conditions) {
      const raw = e[c.name];
      const nested = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
      const conf = toConfidence(nested ? (nested.confidence ?? nested.c ?? nested.score) : raw);
      if (conf === null) continue;
      const why = nested ? (nested.reason ?? nested.why) : (e[`${c.name}_why`] ?? e[`${c.name}_reason`] ?? (conditions.length === 1 ? (e.why ?? e.reason) : undefined));
      rating[c.name] = { confidence: conf, ...(typeof why === "string" && why.trim() ? { reason: why.trim().slice(0, 80) } : {}) };
    }
    if (Object.keys(rating).length) {
      out[idx] = rating;
      any = true;
    }
  });
  return any ? out : null;
}

function toConfidence(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/%$/, "").trim()) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  const scaled = n > 1 ? n / 100 : n;
  return scaled > 1 ? null : scaled;
}

/** The first JSON array or object in `text` that parses. */
function extractJson(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    /* look inside */
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "[" && ch !== "{") continue;
    const end = matchBracket(text, i);
    if (end < 0) continue;
    try {
      return JSON.parse(text.slice(i, end + 1));
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

function matchBracket(text: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") stack.push(ch === "[" ? "]" : "}");
    else if (ch === "]" || ch === "}") {
      if (stack.pop() !== ch) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no reply within ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function short(msg: string): string {
  const one = msg.replace(/\s+/g, " ").trim();
  return one.length > 120 ? one.slice(0, 117) + "…" : one;
}

/** The `skip` condition, built from the profile's Skip section (with Interests as context). */
export function skipCondition(p: ReaderProfile | null): Condition | null {
  if (!p?.skip) return null;
  return {
    name: "skip",
    definition:
      "The headline is one the reader never wants to see: it matches one of these skip patterns. Judge the intent, not the exact wording " +
      '("I Tried 20+ C++ Courses on Udemy" matches "I tried N+ courses"). A substantive post on an unlisted topic is NOT a skip.\n' +
      `Skip patterns:\n${p.skip}` +
      (p.interests ? `\nFor context, what the reader likes (never skip these for being off-topic):\n${p.interests}` : ""),
  };
}

export class SamplingClassifier implements Classifier {
  readonly name = "sampling";
  readonly ranks = false;
  private readonly rater: SamplingRater;

  constructor(sample: SampleFn | null, opts: SamplingRaterOptions = {}) {
    this.rater = new SamplingRater(sample, opts);
  }

  async classify(items: readonly Headline[], profile: ReaderProfile, opts: { deadline?: number } = {}): Promise<ClassifyResult> {
    const condition = skipCondition(profile);
    if (!condition) return { verdicts: items.map(() => null), unavailable: "interests.md has no Skip section", notes: [] };
    const r = await this.rater.rate(items, [condition], opts);
    return {
      verdicts: r.ratings.map((x) => (x?.skip ? { skip: x.skip.confidence, ...(x.skip.reason ? { reason: x.skip.reason } : {}) } : null)),
      ...(r.unavailable ? { unavailable: r.unavailable } : {}),
      notes: r.notes,
    };
  }
}
