/**
 * Picks the classifier backend from the environment.
 *
 *   <PREFIX>_CLASSIFIER   sampling | jev | off (the default is the caller's choice)
 *   OPENROUTER_API_KEY    required for jev
 *   <PREFIX>_JEV_MODEL    default typesafe/jev-1.13 (pin a version: thresholds are tuned against it)
 *
 * jev without a key falls back to sampling with a warning, so a missing key
 * never turns a digest run into an error.
 */
import { JevClassifier, JEV_DEFAULT_MODEL } from "./jev.js";
import { SamplingClassifier, type SampleFn } from "./sampling.js";
import type { Classifier, ClassifyResult } from "./types.js";

export type { Classifier, ClassifyResult, Headline, ReaderProfile, Verdict } from "./types.js";
export { parseProfile } from "./types.js";
export { samplingFn } from "./mcp.js";
export { JevClassifier } from "./jev.js";
export { SamplingClassifier } from "./sampling.js";

/** A classifier that does nothing, for `<PREFIX>_CLASSIFIER=off`. */
export const OFF: Classifier = {
  name: "off",
  ranks: false,
  classify: async (items) => ({ verdicts: items.map(() => null), unavailable: "classifier turned off", notes: [] }),
};

export function classifierFromEnv(
  prefix: string,
  sample: SampleFn | null,
  env: NodeJS.ProcessEnv = process.env,
  fallback: "sampling" | "jev" | "off" = "sampling",
): { classifier: Classifier; warning?: string } {
  const kind = (env[`${prefix}_CLASSIFIER`]?.trim() || fallback).toLowerCase();
  if (kind === "off") return { classifier: OFF };
  if (kind === "jev") {
    const apiKey = env.OPENROUTER_API_KEY?.trim();
    if (apiKey) return { classifier: new JevClassifier({ apiKey, model: env[`${prefix}_JEV_MODEL`]?.trim() || JEV_DEFAULT_MODEL }) };
    return { classifier: new SamplingClassifier(sample), warning: `${prefix}_CLASSIFIER=jev but OPENROUTER_API_KEY isn't set; used sampling.` };
  }
  const warning = kind === "sampling" ? undefined : `${prefix}_CLASSIFIER="${kind}" isn't one of sampling, jev, off; used sampling.`;
  return { classifier: new SamplingClassifier(sample), ...(warning ? { warning } : {}) };
}

/** Exposed for tests and tools: a classify call that never throws. */
export async function classifySafely(c: Classifier, ...args: Parameters<Classifier["classify"]>): Promise<ClassifyResult> {
  try {
    return await c.classify(...args);
  } catch (err) {
    return { verdicts: args[0].map(() => null), unavailable: err instanceof Error ? err.message : String(err), notes: [] };
  }
}
