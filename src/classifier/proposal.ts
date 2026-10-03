/** Checking and describing a proposed interests.md before it's saved. Shared across sources. */
import { parseProfile, splitSection } from "./types.js";

/** Drop a trailing "Changes and why" note, normalize line endings, and check the file has an Interests section. */
export function tidyProposal(text: string): { ok: true; text: string } | { ok: false; error: string } {
  const lines = text.replace(/\r\n/g, "\n").replace(/^```(?:markdown|md)?\n|\n```\s*$/g, "").split("\n");
  const cutAt = lines.findIndex((l) => /^\s*(#+\s*|\*\*)?changes and why/i.test(l));
  const body = (cutAt >= 0 ? lines.slice(0, cutAt) : lines).join("\n").trim() + "\n";
  const p = parseProfile(body);
  if (!/^#{1,6}\s+interests?\b/im.test(body) || !p.interests) return { ok: false, error: 'The proposal needs a "## Interests" section with at least one bullet. Nothing was saved.' };
  return { ok: true, text: body };
}

/** Bullets added and removed per section, compared with the current file. */
export function proposalSummary(current: string, proposed: string): string {
  const a = parseProfile(current);
  const b = parseProfile(proposed);
  const out: string[] = [];
  for (const [name, key] of [["Interests", "interests"], ["Skip", "skip"]] as const) {
    const before = splitSection(a[key]).bullets;
    const after = splitSection(b[key]).bullets;
    const added = after.filter((x) => !before.includes(x));
    const removed = before.filter((x) => !after.includes(x));
    out.push(`${name}: ${after.length} bullet${after.length === 1 ? "" : "s"} (${added.length} new, ${removed.length} removed, ${after.length - added.length} kept)`);
    for (const x of added) out.push(`  + ${x}`);
    for (const x of removed) out.push(`  - ${x}`);
  }
  out.push("To compare against your labels: node --env-file=.env tools/classifier/score.mjs --interests <digest dir>/interests.proposed.md, then node tools/classifier/analyze.mjs.");
  return out.join("\n");
}
