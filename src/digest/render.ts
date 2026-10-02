import type { Judgment, Judgments, RunFile, RunItem } from "./types.js";

/** `Fri, Oct 2, 6:00 AM MDT`: a UTC ISO time shown in `tz`, daylight saving included. */
export function formatLocal(iso: string, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // dateStyle can't be combined with timeZoneName, so list the fields.
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  })
    .format(d)
    .replace(/[  ]/g, " ");
}

/** 950, 1.2k, 12k, 1.3M. */
export function formatClaps(n: number | undefined): string {
  if (n === undefined || n === null) return "-";
  if (n < 1000) return String(n);
  const fmt = (v: number, unit: string) => (v < 10 ? v.toFixed(1).replace(/\.0$/, "") : String(Math.round(v))) + unit;
  return n < 1_000_000 ? fmt(n / 1000, "k") : fmt(n / 1_000_000, "M");
}

export function cut(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1).trimEnd() + "…" : one;
}

/** Medium's reasonString, shortened for the view: `follow:Coding`, `history`, `network`, `clap:Ann`, `selected`. */
export function shortReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  const r = reason.trim();
  let m: RegExpMatchArray | null;
  if ((m = r.match(/^Because you follow (.+)$/i))) return `follow:${m[1]}`;
  if (/reading history/i.test(r)) return "history";
  if (/from your network/i.test(r)) return "network";
  if (/^selected for you$/i.test(r)) return "selected";
  if ((m = r.match(/^(.+?) clapped$/i))) return `clap:${m[1]}`;
  if ((m = r.match(/^(.+?) responded$/i))) return `reply:${m[1]}`;
  return cut(r, 30);
}

/** Escape Markdown emphasis in text we didn't write (titles, names). */
function md(s: string): string {
  return s.replace(/([*_~`])/g, "\\$1");
}

function linkText(s: string): string {
  return md(cut(s, 80)).replace(/([[\]])/g, "\\$1");
}

function link(style: RunFile["style"], title: string, url: string | undefined): string {
  if (!url) return linkText(title);
  return style === "discord" ? `[${linkText(title)}](<${url}>)` : `[${linkText(title)}](${url})`;
}

function oneLine(s: string | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

export interface RenderResult {
  message: string;
  counts: { named: number; readInFull: number; alsoNew: number; skipped: number; unreadable: number };
}

/** The final digest message. Deterministic: the same run and judgments always give the same text. */
export function renderDigest(run: RunFile, j: Judgments): RenderResult {
  const byRef = new Map(run.items.map((i) => [i.ref, i]));
  const item = (ref: string) => byRef.get(ref)!;
  const unreadable = new Set(j.unreadable);
  const preview = new Set(j.preview_only);
  const style = run.style;

  const starred = j.starred.filter((s) => !unreadable.has(s.ref));
  const section = (list: Judgment[]) => list.filter((s) => !unreadable.has(s.ref));
  const following = section(j.following);
  const top = section(j.top_picks);
  const forYou = section(j.for_you);
  const readInFull = starred.length + following.length + top.length + forYou.length;

  const named = new Set([...j.starred, ...j.following, ...j.top_picks, ...j.for_you].map((s) => s.ref).concat(j.unreadable));
  const extraSkipped = new Set(j.extra_skipped.filter((r) => !named.has(r)));
  const skipped = run.items.filter((i) => (i.skipped || extraSkipped.has(i.ref)) && !named.has(i.ref));
  const alsoNew = run.items.filter((i) => i.pool === "following" && !named.has(i.ref) && !i.skipped && !extraSkipped.has(i.ref));

  const marks = (i: RunItem) => `${i.memberOnly ? " [member]" : ""}${preview.has(i.ref) ? " (preview only)" : ""}`;
  const byline = (i: RunItem) => md(i.author ?? "Unknown");
  const blocks: string[] = [];

  if (starred.length) {
    const lines = ["⭐ **Read in full**"];
    starred.forEach((s, n) => {
      const i = item(s.ref);
      lines.push(`${n + 1}. **${md(oneLine(i.title))}** — ${byline(i)}${i.publication ? `, ${md(i.publication)}` : ""}${marks(i)}`);
      lines.push(`   ${oneLine(s.gist)}`);
      if (oneLine(s.why)) lines.push(`   _Why:_ ${oneLine(s.why)}`);
      if (i.url) lines.push(`   ${i.url}`);
    });
    blocks.push(lines.join("\n"));
  }

  const sectionLine = (s: Judgment, withReason: boolean) => {
    const i = item(s.ref);
    const reason = withReason && i.reason ? ` · _${md(oneLine(i.reason))}_` : "";
    const gist = oneLine(s.gist);
    return `• **${md(oneLine(i.title))}** — ${byline(i)}${marks(i)}${gist ? ` · ${gist}` : ""}${reason}${i.url ? ` ${i.url}` : ""}`;
  };

  const alsoLines = alsoNewLines(alsoNew, style);
  if (following.length || alsoLines.length) {
    const lines = ["👥 **Following**", ...following.map((s) => sectionLine(s, false))];
    if (alsoLines.length) lines.push("_Also new_", ...alsoLines);
    blocks.push(lines.join("\n"));
  }
  if (top.length) blocks.push(["🔥 **Medium's top picks**", ...top.map((s) => sectionLine(s, true))].join("\n"));
  if (forYou.length) blocks.push(["🎯 **For you**", ...forYou.map((s) => sectionLine(s, true))].join("\n"));

  const bad = j.unreadable.map(item);
  if (bad.length) blocks.push(["⚠ **Couldn't read**", ...bad.map((i) => `• ${md(oneLine(i.title))}${i.url ? ` ${i.url}` : ""}`)].join("\n"));

  const counts = { named: named.size, readInFull, alsoNew: alsoNew.length, skipped: skipped.length, unreadable: bad.length };
  if (!blocks.length) return { message: "[SILENT]", counts };

  if (skipped.length) blocks.push(`🗑 Skipped ${skipped.length} as clickbait${mostly(skipped)}`);
  const header = `📰 **Medium** — ${run.counts.following_new} new in Following, ${readInFull} read in full (since ${formatLocal(run.since, run.tz)})`;
  return { message: [header, ...blocks].join("\n\n"), counts };
}

/** One line per publication, largest first; authors outside a publication share an "Authors" line. */
export function alsoNewLines(items: readonly RunItem[], style: RunFile["style"], perLine = 3): string[] {
  const groups = new Map<string, RunItem[]>();
  for (const i of items) {
    const key = i.publication ?? "\u0000Authors";
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }
  return [...groups.entries()]
    .map(([key, list], order) => ({ key, list, order }))
    .sort((a, b) => b.list.length - a.list.length || a.order - b.order)
    .map(({ key, list }) => {
      const name = key === "\u0000Authors" ? "Authors" : md(key);
      const links = list.slice(0, perLine).map((i) => link(style, i.title, i.url));
      const more = list.length > perLine ? ` +${list.length - perLine}` : "";
      return `**${name}** (${list.length}) · ${links.join(" · ")}${more}`;
    });
}

/** `(mostly A, B)` naming authors or publications behind 3 or more skipped posts. */
function mostly(skipped: readonly RunItem[]): string {
  const counts = new Map<string, number>();
  for (const i of skipped) {
    for (const name of new Set([i.author, i.publication].filter((x): x is string => Boolean(x)))) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  const top = [...counts.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name]) => md(name));
  return top.length ? ` (mostly ${top.join(", ")})` : "";
}

