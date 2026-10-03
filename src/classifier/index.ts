/**
 * Picks the classifier backend from the environment.
 *
 *   <PREFIX>_CLASSIFIER   sampling | jev | off (the default is the caller's choice)
 *
 * jev talks to any endpoint that speaks the decisions API, configured like an
 * OpenAI-compatible client (URL, key, model):
 *   <PREFIX>_JEV_URL      endpoint to POST to (default OpenRouter's Decisions API)
 *   <PREFIX>_JEV_API_KEY  bearer token (default OPENROUTER_API_KEY); optional for a custom URL
 *   <PREFIX>_JEV_MODEL    default typesafe/jev-1.13 (pin a version: thresholds are tuned against it)
 *
 * jev on the default (OpenRouter) URL without a key falls back to sampling with a
 * warning, so a missing key never turns a digest run into an error.
 */
import { JevClassifier, JEV_DEFAULT_MODEL, JEV_ENDPOINT, type JevOptions } from "./jev.js";
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

/**
 * Jev connection settings from <PREFIX>_JEV_URL / _JEV_API_KEY / _JEV_MODEL, or an
 * error message when they can't work (the default OpenRouter URL with no key).
 */
export function jevOptionsFromEnv(prefix: string, env: NodeJS.ProcessEnv = process.env): { opts: JevOptions } | { error: string } {
  const endpoint = env[`${prefix}_JEV_URL`]?.trim() || JEV_ENDPOINT;
  const apiKey = env[`${prefix}_JEV_API_KEY`]?.trim() || env.OPENROUTER_API_KEY?.trim() || undefined;
  const model = env[`${prefix}_JEV_MODEL`]?.trim() || JEV_DEFAULT_MODEL;
  if (!apiKey && endpoint === JEV_ENDPOINT) return { error: `${prefix}_CLASSIFIER=jev but neither ${prefix}_JEV_API_KEY nor OPENROUTER_API_KEY is set` };
  return { opts: { endpoint, model, ...(apiKey ? { apiKey } : {}) } };
}

export function classifierFromEnv(
  prefix: string,
  sample: SampleFn | null,
  env: NodeJS.ProcessEnv = process.env,
  fallback: "sampling" | "jev" | "off" = "sampling",
): { classifier: Classifier; warning?: string } {
  const kind = (env[`${prefix}_CLASSIFIER`]?.trim() || fallback).toLowerCase();
  if (kind === "off") return { classifier: OFF };
  if (kind === "jev") {
    const jev = jevOptionsFromEnv(prefix, env);
    if ("opts" in jev) return { classifier: new JevClassifier(jev.opts) };
    return { classifier: new SamplingClassifier(sample), warning: `${jev.error}; used sampling.` };
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
