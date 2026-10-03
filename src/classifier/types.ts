/**
 * The headline classifier: the step that decides, before any model reads a post,
 * which headlines matter to this reader. It is separate from summarizing and
 * presenting on purpose — it's the part of the digest that encodes taste, so it
 * gets its own interface, its own backends, and its own evaluation loop
 * (tools/classifier/, docs/classifier.md).
 *
 * Nothing in src/classifier/ imports source-specific code: the same component
 * ships in medium-reader-mcp and substack-reader-mcp, and the copies stay alike.
 */

/** What a classifier sees of a post. */
export interface Headline {
  title: string;
  subtitle?: string;
  author?: string;
  publication?: string;
}

/** The reader, from interests.md: both sections are free text, usually "- " bullets. */
export interface ReaderProfile {
  interests?: string;
  skip?: string;
}

export interface Verdict {
  /** 0–1, higher = the reader wants it more. Absent when the backend doesn't rank. */
  rank?: number;
  /** 0–1 probability that the headline matches one of the reader's Skip patterns. */
  skip?: number;
  /** Short reason, when the backend gives one. */
  reason?: string;
}

export interface ClassifyResult {
  /** One per input headline, same order; null when that headline wasn't classified. */
  verdicts: Array<Verdict | null>;
  /** Set when nothing could be classified (no key, no sampling support, every request failed). */
  unavailable?: string;
  /** Partial failures. */
  notes: string[];
}

export interface Classifier {
  /** Shown in the digest's status line, e.g. "jev (typesafe/jev-1.13)". */
  readonly name: string;
  /** Whether verdicts carry `rank`. */
  readonly ranks: boolean;
  classify(items: readonly Headline[], profile: ReaderProfile, opts?: { deadline?: number }): Promise<ClassifyResult>;
}

/** "- " bullets of a profile section, and the prose around them. */
export function splitSection(text: string | undefined): { bullets: string[]; prose: string } {
  const lines = (text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return {
    bullets: lines.filter((l) => /^[-*] /.test(l)).map((l) => l.slice(2).trim()),
    prose: lines.filter((l) => !/^[-*] /.test(l)).join(" "),
  };
}

/**
 * Parse interests.md into a profile: the bodies of "## Interests" and "## Skip"
 * (headings matched case-insensitively). A file with neither heading is all interests.
 */
export function parseProfile(md: string): ReaderProfile {
  const buf: Record<"interests" | "skip", string[]> = { interests: [], skip: [] };
  let current: "interests" | "skip" | null = null;
  let headed = false;
  for (const line of md.split(/\r?\n/)) {
    const h = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (h) {
      const name = h[1]!.toLowerCase();
      current = /^interests?\b/.test(name) ? "interests" : /^skip\b/.test(name) ? "skip" : null;
      if (current) headed = true;
      continue;
    }
    if (current) buf[current].push(line);
  }
  if (!headed) {
    const text = md.replace(/^#{1,6} .*$/gm, "").trim();
    return text ? { interests: text } : {};
  }
  const out: ReaderProfile = {};
  for (const key of ["interests", "skip"] as const) {
    const text = buf[key].join("\n").trim();
    if (text) out[key] = text;
  }
  return out;
}
