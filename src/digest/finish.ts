import { stat } from "node:fs/promises";
import { DIGEST_FILES } from "../config.js";
import { parsePostId } from "../medium/api.js";
import { raterLine } from "./collect.js";
import { formatLocal, renderDigest } from "./render.js";
import { commitState, insideDir, isoSeconds, listRunIds, loadState, readRun, writeRun } from "./state.js";
import type { Judgment, Judgments, Pool, RunFile, RunItem } from "./types.js";

export const DIGEST_MARKER = "===== DIGEST: reply with exactly the text below, nothing before or after =====";
const REF = /^[FTY]\d{1,3}$/i;
const LIMITS = { starred: 8, starGist: 400, why: 250, gist: 280 };

/**
 * Shorten text to at most n characters (including the "…") at a readable break: the
 * last sentence or clause end if that keeps at least 60% of the room, else the last
 * word break, so a gist never ends mid-word.
 */
export function shorten(t: string, n: number): string {
  if (t.length <= n) return t;
  const room = t.slice(0, n - 1);
  const clause = Math.max(...[". ", "; ", ": ", ", ", " — ", " - "].map((sep) => room.lastIndexOf(sep)));
  if (clause >= n * 0.6) return room.slice(0, clause).replace(/[\s,;:—-]+$/, "") + (room[clause] === "." ? "." : "…");
  const space = room.lastIndexOf(" ");
  return (space > 0 ? room.slice(0, space) : room).replace(/[\s,;:—-]+$/, "") + "…";
}

/** An error the model can act on; the message is shown as is. */
export class DigestInputError extends Error {}

export async function latestRun(dir: string): Promise<RunFile | null> {
  const ids = await listRunIds(dir);
  const id = ids[ids.length - 1];
  return id ? readRun<RunFile>(dir, id) : null;
}

export function isDigestRef(s: string): boolean {
  return REF.test(s.trim());
}

/** Find a run item by ref (`f3`), post id or URL. */
export function findItem(run: RunFile, raw: string): RunItem | undefined {
  const s = raw.trim();
  if (REF.test(s)) return run.items.find((i) => i.ref === s.toUpperCase());
  let id: string;
  try {
    id = parsePostId(s);
  } catch {
    return undefined;
  }
  return run.items.find((i) => i.id === id);
}

function refRanges(run: RunFile): string {
  const last = (p: Pool) => run.items.filter((i) => i.pool === p).length;
  const parts = ([["following", "F"], ["top", "T"], ["for_you", "Y"]] as const).map(([p, x]) => (last(p) ? `${x}1–${x}${last(p)}` : null)).filter(Boolean);
  return parts.length ? parts.join(", ") : "none (the run found nothing new)";
}

/** Resolve a digest ref for read_post against the latest run. */
export async function resolveReadRef(dir: string, ref: string): Promise<string> {
  const run = await latestRun(dir);
  if (!run) throw new DigestInputError(`"${ref}" looks like a digest ref, but there is no digest run yet. Call digest_begin first, or pass the post URL.`);
  const item = findItem(run, ref);
  if (!item) throw new DigestInputError(`${ref.toUpperCase()} isn't in the latest digest run (${run.run_id}); its refs are ${refRanges(run)}.`);
  return item.url ?? item.id;
}

export interface FinishInput {
  run_id?: string;
  starred: Array<{ ref: string; gist?: string; why?: string }>;
  following: Array<{ ref: string; gist?: string }>;
  top_picks: Array<{ ref: string; gist?: string }>;
  for_you: Array<{ ref: string; gist?: string }>;
  preview_only: string[];
  unreadable: string[];
  extra_skipped: string[];
  dry_run: boolean;
}

/** Check the model's picks against the run and normalize them. Unknown refs throw; everything else is fixed up with a warning. */
export function resolveJudgments(run: RunFile, input: FinishInput): { judgments: Judgments; warnings: string[] } {
  const warnings: string[] = [];
  const unknown: string[] = [];
  const resolve = (raw: string): RunItem | undefined => {
    const item = findItem(run, String(raw));
    if (!item) unknown.push(String(raw));
    return item;
  };
  const used = new Set<string>();
  const sectionOf: Record<Pool, Judgment[]> = { following: [], top: [], for_you: [] };
  const starred: Judgment[] = [];
  const trimmed = (s: string | undefined, n: number, ref: string, what: string) => {
    const t = (s ?? "").replace(/\s+/g, " ").trim();
    if (t.length <= n) return t;
    warnings.push(`${ref} ${what} cut to ${n} characters.`);
    return shorten(t, n);
  };

  for (const s of input.starred) {
    const item = resolve(s.ref);
    if (!item) continue;
    if (used.has(item.ref)) {
      warnings.push(`${item.ref} was given twice; kept the first.`);
      continue;
    }
    used.add(item.ref);
    const j: Judgment = { ref: item.ref, gist: trimmed(s.gist, LIMITS.starGist, item.ref, "gist"), why: trimmed(s.why, LIMITS.why, item.ref, "why") };
    if (starred.length >= LIMITS.starred) {
      warnings.push(`More than ${LIMITS.starred} starred; ${item.ref} moved to its section.`);
      sectionOf[item.pool].push({ ref: j.ref, gist: trimmed(j.gist, LIMITS.gist, item.ref, "gist") });
    } else starred.push(j);
  }
  const lists: Array<[Pool, FinishInput["following"]]> = [
    ["following", input.following],
    ["top", input.top_picks],
    ["for_you", input.for_you],
  ];
  for (const [pool, list] of lists) {
    for (const s of list) {
      const item = resolve(s.ref);
      if (!item) continue;
      if (used.has(item.ref)) {
        if (!starred.some((x) => x.ref === item.ref)) warnings.push(`${item.ref} was given twice; kept the first.`);
        continue;
      }
      used.add(item.ref);
      if (item.pool !== pool) warnings.push(`${item.ref} belongs in ${sectionName(item.pool)}, not ${sectionName(pool)}; moved it.`);
      sectionOf[item.pool].push({ ref: item.ref, gist: trimmed(s.gist, LIMITS.gist, item.ref, "gist") });
    }
  }
  const refList = (list: string[]) => [...new Set(list.map(resolve).filter((i): i is RunItem => Boolean(i)).map((i) => i.ref))];
  const judgments: Judgments = {
    starred,
    following: sectionOf.following,
    top_picks: sectionOf.top,
    for_you: sectionOf.for_you,
    preview_only: refList(input.preview_only),
    unreadable: refList(input.unreadable),
    extra_skipped: refList(input.extra_skipped),
  };
  if (unknown.length) {
    throw new DigestInputError(
      `Unknown refs: ${[...new Set(unknown)].join(", ")}. Run ${run.run_id} has ${refRanges(run)}. ` +
        "Use refs exactly as digest_begin listed them (or the post URL). Nothing was saved; fix those entries and call digest_finish again.",
    );
  }
  for (const r of judgments.extra_skipped) {
    if (used.has(r)) warnings.push(`${r} is in extra_skipped but was also picked; kept the pick.`);
  }
  return { judgments, warnings };
}

function sectionName(p: Pool): string {
  return p === "following" ? "following" : p === "top" ? "top_picks" : "for_you";
}

export async function digestFinish(dir: string, input: FinishInput, opts: { keep: number; now?: () => Date }): Promise<string> {
  const now = opts.now ?? (() => new Date());
  const run = input.run_id ? await readRun<RunFile>(dir, input.run_id.trim()) : await latestRun(dir);
  if (!run) {
    const ids = await listRunIds(dir);
    throw new DigestInputError(
      input.run_id
        ? `No digest run "${input.run_id}". Recent runs: ${ids.slice(-5).join(", ") || "none"}. Omit run_id to use the latest.`
        : "There is no digest run yet. Call digest_begin first.",
    );
  }

  if (run.committed_at && run.judgments) {
    const { message, counts } = renderDigest(run, run.judgments);
    return [
      `STATE SAVED: already saved at ${run.committed_at}; nothing changed (showing the digest from that call).`,
      countsLine(run, counts),
      "WARNINGS: none",
      DIGEST_MARKER,
      message,
    ].join("\n");
  }

  const { judgments, warnings } = resolveJudgments(run, input);
  const { message, counts } = renderDigest(run, judgments);
  const head: string[] = [];
  if (input.dry_run) {
    head.push("STATE SAVED: no (dry run; nothing written)");
  } else {
    const byRef = new Map(run.items.map((i) => [i.ref, i]));
    const named = [...judgments.starred, ...judgments.following, ...judgments.top_picks, ...judgments.for_you].map((j) => j.ref);
    const ids = [
      ...run.items.filter((i) => i.pool === "following").map((i) => i.id),
      ...[...named, ...judgments.unreadable, ...judgments.extra_skipped].map((r) => byRef.get(r)!.id),
    ];
    const result = await commitState(dir, { add: ids, lastRun: run.started_at, keep: opts.keep });
    warnings.push(...result.warnings);
    const summary = `${result.added} ids added (${result.alreadyPresent} already present), ${result.total} total, last_run ${result.lastRun}`;
    run.committed_at = isoSeconds(now());
    run.judgments = judgments;
    run.commit_summary = summary;
    await writeRun(dir, run.run_id, run);
    head.push(`STATE SAVED: ${summary}`);
  }
  return [...head, countsLine(run, counts), `WARNINGS: ${warnings.length ? warnings.join(" ") : "none"}`, DIGEST_MARKER, message].join("\n");
}

function countsLine(run: RunFile, c: ReturnType<typeof renderDigest>["counts"]): string {
  return `COUNTS: ${run.counts.following_new} new in Following · ${c.readInFull} read in full · ${c.alsoNew} also new · ${c.skipped} skipped · ${c.unreadable} unreadable`;
}

export async function digestStatus(
  dir: string,
  config: { tz: string; style: string; keep: number; threshold: number; classifier?: string; rankFloor?: number; rankFloorMode?: "compact" | "exclude" },
): Promise<string> {
  const loaded = await loadState(dir);
  const lines: string[] = [];
  if (loaded.status === "ok") {
    const file = await insideDir(dir, DIGEST_FILES.state);
    const mtime = (await stat(file)).mtime;
    const last = loaded.state.last_run;
    lines.push(
      `State: last_run ${last ?? "(none)"}${last ? ` (${formatLocal(last, config.tz)})` : ""} · ${loaded.state.reported_posts.length} ids · state.json written ${isoSeconds(mtime)}`,
    );
  } else {
    lines.push(loaded.status === "missing" ? "State: no state.json yet (the next run covers the last 24 hours)." : `State: ${loaded.warning}`);
  }
  lines.push(
    `Config: dir ${dir} · tz ${config.tz} · style ${config.style} · keep ${config.keep} · skip threshold ${Math.round(config.threshold * 100)}%` +
      (config.classifier ? ` · classifier ${config.classifier}` : "") +
      (config.rankFloor ? ` · rank floor ${Math.round(config.rankFloor * 100)}%${config.rankFloorMode === "exclude" ? " (exclude)" : ""}` : ""),
  );
  const ids = (await listRunIds(dir)).reverse().slice(0, 5);
  if (!ids.length) {
    lines.push("Runs: none yet.");
    return lines.join("\n");
  }
  lines.push("Runs (newest first):");
  for (const id of ids) {
    const r = await readRun<RunFile>(dir, id);
    if (!r) continue;
    const c = r.counts;
    lines.push(
      `- ${id} · ${r.committed_at ? `committed ${r.committed_at}` : "PENDING (not committed)"} · Following ${c.following_new}, Top ${c.top}, For you ${c.for_you} · ${raterLine(r.rater)}` +
        (r.commit_summary ? ` · ${r.commit_summary}` : ""),
    );
  }
  const latest = await readRun<RunFile>(dir, ids[0]!);
  if (latest && !latest.committed_at) {
    const pending = latest.items.filter((i) => i.pool === "following").length;
    lines.push(`Latest run is pending: digest_finish would commit ${pending} Following ids plus the named Top/For you picks, and set last_run to ${latest.started_at}.`);
  }
  return lines.join("\n");
}

export async function markReported(dir: string, input: { ids: string[]; last_run?: string }, opts: { keep: number; now?: () => Date }): Promise<{ text: string; ok: boolean }> {
  const now = opts.now ?? (() => new Date());
  const run = await latestRun(dir);
  const ids: string[] = [];
  const bad: string[] = [];
  for (const raw of input.ids) {
    const s = String(raw).trim();
    if (!s) continue;
    if (REF.test(s)) {
      const item = run && findItem(run, s);
      if (item) ids.push(item.id);
      else bad.push(s);
      continue;
    }
    try {
      ids.push(parsePostId(s));
    } catch {
      bad.push(s);
    }
  }
  let lastRun: string | undefined;
  if (input.last_run) {
    const v = input.last_run.trim();
    const t = v.toLowerCase() === "now" ? now().getTime() : Date.parse(v);
    if (Number.isNaN(t)) return { ok: false, text: `last_run "${v}" isn't an ISO time or "now". Nothing was saved.` };
    lastRun = isoSeconds(new Date(t));
  }
  if (!ids.length && !lastRun) return { ok: false, text: `None of these are post ids, URLs or refs in the latest run: ${bad.join(", ")}. Nothing was saved.` };
  const result = await commitState(dir, { add: ids, lastRun, keep: opts.keep });
  const unique = new Set(ids).size;
  const lines = [`Added ${result.added} (${unique - result.added} already present). ${result.total} ids. last_run ${result.lastRun ?? "(none)"}`];
  if (lastRun && result.lastRun !== lastRun) lines.push(`last_run stayed at ${result.lastRun}: it never moves backwards.`);
  if (bad.length) lines.push(`Not understood (skipped): ${bad.join(", ")}`);
  lines.push(...result.warnings);
  return { ok: true, text: lines.join("\n") };
}
