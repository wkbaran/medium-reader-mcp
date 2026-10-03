/**
 * Evidence for drafting interests.md: what the reader's own activity says about their
 * taste, laid out as plain text for a language model to turn into a proposal.
 *
 * Each source gathers its own signals (reading lists, follows, subscriptions, history,
 * the digest's picks, hand labels) into `EvidenceSection`s; this file renders them with
 * drafting rules learned from evaluating the classifier (docs/classifier.md, Evidence).
 * The proposal is meant to be scored against the reader's labels before it replaces
 * interests.md, never adopted blind.
 */
import { createHash } from "node:crypto";

export interface EvidenceItem {
  title: string;
  subtitle?: string;
  author?: string;
  publication?: string;
  /** Extra context, e.g. "paid", "must", "in 3 lists". */
  note?: string;
}

export type Strength = "strong" | "medium" | "weak" | "negative";

export interface EvidenceSection {
  title: string;
  strength: Strength;
  /** One line: what this signal is and how far to trust it. */
  about: string;
  items?: EvidenceItem[];
  /** Free lines (e.g. a list of publication names) instead of, or as well as, items. */
  lines?: string[];
  /** Total available when only some were included. */
  total?: number;
}

export interface Evidence {
  /** "Medium", "Substack". */
  source: string;
  /** The current interests.md, if any. */
  current?: string;
  sections: EvidenceSection[];
  /** Signals that couldn't be gathered, and why. */
  warnings: string[];
  /** Where a proposal can be saved, e.g. "save_interests_proposal". */
  saveHint?: string;
}

const STRENGTH_ORDER: Strength[] = ["strong", "medium", "negative", "weak"];
const STRENGTH_LABEL: Record<Strength, string> = {
  strong: "STRONG: chosen deliberately",
  medium: "MEDIUM: implied, or chosen by the digest's model",
  negative: "NEGATIVE: what the reader rejects (the only basis for Skip bullets)",
  weak: "WEAK: clicked, which includes regretted clicks",
};

export const DRAFTING_RULES = `How to draft interests.md from this evidence:
- Write a complete file with exactly two sections, "## Interests" and "## Skip", each a list of "- " bullets. A classifier ranks every headline against Interests and drops ones that clearly match Skip, so every bullet must be judgeable from a headline.
- Interests: 4–10 bullets. Each names a topic area as the reader actually reads it, plus the kind of substance they go for when the evidence shows it (e.g. "with real numbers", "from practitioners", "long-form essays"). Base them on STRONG and MEDIUM signals. Use WEAK signals only for topics that recur (3+ posts) or that confirm a stronger signal. Name an author or publication only when it recurs across signals.
- Keep current bullets that the evidence supports, reword ones it contradicts, and add topics the reader clearly reads but the file doesn't mention, including non-technical ones (essays, travel, history, crafts): a missing topic makes the classifier rank those posts at the bottom.
- Skip: only from NEGATIVE evidence. If there's none, keep the current Skip bullets that don't contradict the positive evidence, and add nothing.
- Skip bullets describe a kind of post by intent ("hustle-bro income claims with no track record"), never a title style ("numbered lists", "clickbait phrasing", "X is dead"): measured on real labels, style-based skips dropped posts the reader wanted, because clickbait-style titles are how the platform rewards writers.
- Never put a whole topic the reader reads under Skip; narrow it to the bad version instead (e.g. not "money", but "get-rich-quick money posts").
- One line of plain prose under the Skip heading saying "A catchy or numbered title alone is not a reason to skip; judge what the post is about." is fine and helps.
- After the file, add a short "Changes and why" list (3–8 lines) tying each change to the evidence.`;

/** Render evidence as plain text under `maxChars`. Over budget, subtitles go first (weakest sections first), then items, from whichever section is largest for its strength. */
export function renderEvidence(ev: Evidence, maxChars = 38_000): string {
  const sections = [...ev.sections].sort((a, b) => STRENGTH_ORDER.indexOf(a.strength) - STRENGTH_ORDER.indexOf(b.strength));
  const caps = sections.map((s) => s.items?.length ?? 0);
  const terse = sections.map(() => false);
  let text = build(ev, sections, caps, terse);
  for (const strength of ["weak", "medium", "negative", "strong"] as Strength[]) {
    if (text.length <= maxChars) break;
    sections.forEach((s, n) => s.strength === strength && (terse[n] = true));
    text = build(ev, sections, caps, terse);
  }
  const weight: Record<Strength, number> = { strong: 3, negative: 3, medium: 2, weak: 1 };
  while (text.length > maxChars) {
    let best = -1;
    sections.forEach((s, n) => {
      if (caps[n]! > 10 && (best < 0 || caps[n]! / weight[s.strength] > caps[best]! / weight[sections[best]!.strength])) best = n;
    });
    if (best < 0) break;
    caps[best] = Math.max(10, Math.floor(caps[best]! * 0.85));
    text = build(ev, sections, caps, terse);
  }
  return text.length > maxChars ? text.slice(0, maxChars - 40) + "\n[evidence truncated for size]" : text;
}

function build(ev: Evidence, sections: EvidenceSection[], caps: number[], terse: boolean[]): string {
  const out: string[] = [
    `INTERESTS EVIDENCE · ${ev.source}`,
    "",
    "Use this to propose a new interests.md for the reader. Ask the reader before replacing their current file.",
    "",
    DRAFTING_RULES,
    "",
    ev.saveHint ? `Then: ${ev.saveHint}` : "Then: show the proposal to the reader.",
    "",
    "===== CURRENT interests.md =====",
    ev.current?.trim() || "(none yet)",
    "===== END CURRENT =====",
  ];
  if (ev.warnings.length) out.push("", "Not available:", ...ev.warnings.map((w) => `- ${w}`));
  sections.forEach((s, n) => {
    const all = s.items ?? [];
    const items = all.slice(0, caps[n]);
    const total = s.total ?? all.length;
    const count = all.length ? (total > items.length ? `${items.length} of ${total} shown` : `${total}`) : `${total}`;
    out.push("", `## ${s.title} [${STRENGTH_LABEL[s.strength]}] (${count})`, s.about);
    if (all.length) {
      const tally = topCounts(all);
      if (tally) out.push(`Most frequent: ${tally}`);
    }
    for (const l of s.lines ?? []) out.push(l);
    for (const it of items) out.push(itemLine(it, terse[n]!));
  });
  return out.join("\n");
}

function itemLine(it: EvidenceItem, terse: boolean): string {
  const who = [it.author, it.publication].filter(Boolean).join(", ");
  const sub = it.subtitle && !terse ? ` — ${cut(it.subtitle, 110)}` : "";
  return `- ${cut(it.title, 120)}${sub}${who ? ` (${cut(who, 60)})` : ""}${it.note ? ` [${it.note}]` : ""}`;
}

/** "Publication ×5, Author ×3, …": anything appearing 3+ times in the section (counted over all items, shown or not). */
function topCounts(items: EvidenceItem[]): string {
  const m = new Map<string, number>();
  for (const it of items) for (const k of new Set([it.publication, it.author].filter((x): x is string => Boolean(x)))) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([k, n]) => `${k} ×${n}`)
    .join(", ");
}

function cut(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The fixed half of labels a proposal may be drafted from ("train"); the other half is for
 * testing it (tools/classifier/analyze.mjs --test-half uses the same split). Without this,
 * a proposal drafted from the labels would be graded on the labels it was written from.
 */
export function isTrainLabel(id: string): boolean {
  return createHash("sha256").update(id).digest()[0]! % 2 === 0;
}

/**
 * Hand labels and the digest's picks, from the files the classifier tools and the
 * digest keep: `labels` maps an item id to skip|meh|read|must, `dataset` maps ids to
 * headlines. Shared by every source's gatherer.
 */
export function labelSections(labels: Map<string, string>, dataset: Map<string, EvidenceItem>): EvidenceSection[] {
  const pick = (want: (l: string) => boolean) =>
    [...labels].filter(([id, l]) => want(l) && dataset.has(id)).map(([id, l]) => ({ ...dataset.get(id)!, note: l }));
  const wanted = pick((l) => l === "must" || l === "read").sort((a, b) => (a.note === b.note ? 0 : a.note === "must" ? -1 : 1));
  const rejected = pick((l) => l === "skip");
  const out: EvidenceSection[] = [];
  if (wanted.length) out.push({ title: "Labelled must or read", strength: "strong", about: "The reader's own one-keypress judgments of headlines (label.mjs).", items: wanted });
  if (rejected.length) out.push({ title: "Labelled skip", strength: "negative", about: "Headlines the reader labelled as never wanting to see.", items: rejected });
  return out;
}
