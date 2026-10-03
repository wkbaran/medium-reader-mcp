/**
 * The Jev backend: TypeSafe's Jev decision model through OpenRouter's Decisions API
 * (docs/jev/). Jev returns typed answers with probabilities instead of text, so each
 * headline gets a calibrated rank and skip probability in ~0.1–0.3 s, for about
 * $0.03 per 1,000 headlines (input tokens only).
 *
 * One request per headline: Jev judges one `state` against several questions, so
 * headlines can't be batched into one prompt. Requests run a few at a time.
 *
 * The questions are the ones benchmarked in experiments/jev (profile in state,
 * title + subtitle + author + publication): see docs/classifier.md for results.
 */
import { splitSection, type Classifier, type ClassifyResult, type Headline, type ReaderProfile, type Verdict } from "./types.js";

export const JEV_DEFAULT_MODEL = "typesafe/jev-1.13";
export const JEV_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";

/** The rank scale, lowest first. The answer's probability-weighted position becomes rank = score / (levels - 1). */
export const RANK_LEVELS = [
  "Not for this reader: off-topic or matches a skip pattern",
  "Marginal: related area, little reason to open it",
  "Worth a skim",
  "Must read: squarely in the reader's interests with real substance",
] as const;

export interface JevOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
  /** Requests in flight at once. */
  concurrency?: number;
  /** Per-request timeout. */
  requestTimeoutMs?: number;
  /** Don't start a request with less than this much of the deadline left. */
  minRequestMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

type Answers = Record<string, { type: string; noul?: number; score?: number; confidence?: number }>;

class FatalError extends Error {}

export class JevClassifier implements Classifier {
  readonly ranks = true;
  readonly name: string;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly concurrency: number;
  private readonly requestTimeoutMs: number;
  private readonly minRequestMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: JevOptions) {
    this.model = opts.model ?? JEV_DEFAULT_MODEL;
    this.name = `jev (${this.model})`;
    this.endpoint = opts.endpoint ?? JEV_ENDPOINT;
    this.concurrency = opts.concurrency ?? 8;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 20_000;
    this.minRequestMs = opts.minRequestMs ?? 2_000;
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** The request body for one headline. Exported through the class so the tools in tools/classifier score exactly what the server sends. */
  body(item: Headline, profile: ReaderProfile): Record<string, unknown> {
    const interests = splitSection(profile.interests);
    const skip = splitSection(profile.skip);
    const reader: Record<string, unknown> = {};
    if (interests.bullets.length || interests.prose) reader.interests = interests.bullets.length ? interests.bullets : interests.prose;
    if (skip.bullets.length) reader.skips = skip.bullets;
    const note = skip.prose.replace(/^Titles matching these patterns \(by intent, not exact wording\) are dropped entirely\.\s*/i, "");
    if (note) reader.skip_note = note;
    const questions: Record<string, unknown> = {
      importance: {
        type: "score",
        instructions: "Given the reader's interests and skips, how much would this reader want to read this post?",
        criteria: [...RANK_LEVELS],
      },
    };
    if (skip.bullets.length || skip.prose) {
      questions.skip_ctx = { type: "noul", instructions: "Should this post be dropped because it matches one of the reader's skips?" };
    }
    return {
      model: this.model,
      state: {
        reader,
        headline: { title: item.title, subtitle: item.subtitle ?? "", author: item.author ?? "", publication: item.publication ?? "self-published" },
      },
      questions,
    };
  }

  async classify(items: readonly Headline[], profile: ReaderProfile, opts: { deadline?: number } = {}): Promise<ClassifyResult> {
    const verdicts: Array<Verdict | null> = items.map(() => null);
    if (!items.length) return { verdicts, notes: [] };
    const deadline = opts.deadline ?? Infinity;
    const errors: string[] = [];
    let fatal: string | undefined;
    let next = 0;
    let ok = 0;
    let outOfTime = 0;
    let pauseUntil = 0;

    const worker = async () => {
      while (next < items.length && !fatal) {
        const n = next++;
        if (deadline - this.now() < this.minRequestMs) {
          outOfTime++;
          continue;
        }
        try {
          const answers = await this.request(this.body(items[n]!, profile), deadline, () => pauseUntil, (t) => (pauseUntil = t));
          const v = toVerdict(answers);
          if (v) {
            verdicts[n] = v;
            ok++;
          }
        } catch (err) {
          if (err instanceof FatalError) fatal = err.message;
          else errors.push(err instanceof Error ? err.message : String(err));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, items.length) }, worker));

    if (fatal) return { verdicts, unavailable: fatal, notes: [] };
    if (!ok) return { verdicts, unavailable: errors[0] ? short(errors[0]) : "no time left to classify", notes: [] };
    const notes: string[] = [];
    if (errors.length) notes.push(`${errors.length} headlines unclassified (${short(errors[0]!)})`);
    if (outOfTime) notes.push(`time ran out; ${outOfTime} headlines unclassified`);
    return { verdicts, notes };
  }

  private async request(body: Record<string, unknown>, deadline: number, getPause: () => number, setPause: (t: number) => void): Promise<Answers> {
    for (let attempt = 0; ; attempt++) {
      const wait = getPause() - this.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const left = deadline - this.now();
      if (left < this.minRequestMs) throw new Error("time ran out");
      const res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.min(this.requestTimeoutMs, left)),
      });
      if (res.ok) return ((await res.json()) as { answers: Answers }).answers;
      const text = await res.text().catch(() => "");
      // 401/403: bad key. 402 without an in-flight budget: out of credits. Neither gets better by retrying.
      if (res.status === 401 || res.status === 403 || (res.status === 402 && !text.includes("in_flight_budget"))) {
        throw new FatalError(`OpenRouter refused the request (HTTP ${res.status}${text ? `: ${short(text)}` : ""})`);
      }
      const retryable = res.status === 429 || res.status === 402 || res.status >= 500;
      if (!retryable || attempt >= 3) throw new Error(`HTTP ${res.status}${text ? `: ${short(text)}` : ""}`);
      const ra = Number(res.headers.get("retry-after"));
      setPause(this.now() + (ra > 0 ? ra * 1000 : Math.min(8_000, 500 * 2 ** attempt)));
    }
  }
}

function toVerdict(a: Answers | undefined): Verdict | null {
  const score = a?.importance?.score;
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  const v: Verdict = { rank: clamp(score / (RANK_LEVELS.length - 1)) };
  const skip = a?.skip_ctx?.noul;
  if (typeof skip === "number" && Number.isFinite(skip)) v.skip = clamp(skip);
  return v;
}

const clamp = (n: number) => Math.min(1, Math.max(0, n));

function short(msg: string): string {
  const one = msg.replace(/\s+/g, " ").trim();
  return one.length > 120 ? one.slice(0, 117) + "…" : one;
}
