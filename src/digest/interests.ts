import { readFile } from "node:fs/promises";
import { DIGEST_FILES } from "../config.js";
import type { Condition } from "./rater.js";
import { insideDir } from "./state.js";

export interface Interests {
  /** Body of the "## Interests" section, trimmed. */
  interests?: string;
  /** Body of the "## Skip" section, trimmed. */
  skip?: string;
}

/** Split interests.md into its `## Interests` and `## Skip` sections (by heading, case-insensitive). */
export function parseInterests(md: string): Interests {
  const out: Interests = {};
  let current: keyof Interests | null = null;
  const buf: Record<keyof Interests, string[]> = { interests: [], skip: [] };
  for (const line of md.split(/\r?\n/)) {
    const h = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (h) {
      const name = h[1]!.toLowerCase();
      current = /^interests?\b/.test(name) ? "interests" : /^skip\b/.test(name) ? "skip" : null;
      continue;
    }
    if (current) buf[current].push(line);
  }
  for (const key of ["interests", "skip"] as const) {
    const text = buf[key].join("\n").trim();
    if (text) out[key] = text;
  }
  return out;
}

export async function loadInterests(dir: string): Promise<Interests | null> {
  try {
    return parseInterests(await readFile(await insideDir(dir, DIGEST_FILES.interests), "utf8"));
  } catch {
    return null;
  }
}

/** The `skip` condition the rater decides, built from the Skip section (with Interests as context). */
export function skipCondition(i: Interests | null): Condition | null {
  if (!i?.skip) return null;
  return {
    name: "skip",
    definition:
      "The headline is one the reader never wants to see: it matches one of these skip patterns. Judge the intent, not the exact wording " +
      '("I Tried 20+ C++ Courses on Udemy" matches "I tried N+ courses"). A substantive post on an unlisted topic is NOT a skip.\n' +
      `Skip patterns:\n${i.skip}` +
      (i.interests ? `\nFor context, what the reader likes (never skip these for being off-topic):\n${i.interests}` : ""),
  };
}
