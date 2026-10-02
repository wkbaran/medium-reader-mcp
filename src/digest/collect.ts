import type { MediumClient, PostSummary, RankedPost } from "../medium/api.js";
import { parseSince } from "../tool-util.js";
import { loadInterests, skipCondition, type Interests } from "./interests.js";
import type { TitleRater } from "./rater.js";
import { cut, formatClaps, formatLocal, shortReason } from "./render.js";
import { isoSeconds, loadState, newRunId, pruneRuns, writeRun } from "./state.js";
import { POOL_PREFIX, type Pool, type RunFile, type RunItem } from "./types.js";

export interface BeginOptions {
  since?: string;
  following_max: number;
  top_picks: number;
  for_you_end: number;
  for_you_min: number;
  for_you_extend_to: number;
  history: number;
  max_chars: number;
}

export const BEGIN_DEFAULTS: BeginOptions = {
  following_max: 400,
  top_picks: 25,
  for_you_end: 100,
  for_you_min: 20,
  for_you_extend_to: 150,
  history: 45,
  max_chars: 40_000,
};

/** For you starts here; positions before it are Medium's top picks. */
export const FOR_YOU_START = 25;

export interface BeginDeps {
  client: MediumClient;
  dir: string;
  rater: TitleRater;
  tz: { tz: string; warning?: string };
  style: RunFile["style"];
  threshold: number;
  now?: () => Date;
  /** Total time digest_begin may spend before the rater stops (fetching included). */
  budgetMs?: number;
}

export async function digestBegin(opts: BeginOptions, deps: BeginDeps): Promise<{ run: RunFile; view: string }> {
  const now = deps.now ?? (() => new Date());
  const user = await deps.client.whoami(); // an expired session fails here, before anything else
  const startedAt = now();
  const warnings: string[] = deps.tz.warning ? [deps.tz.warning] : [];

  const loaded = await loadState(deps.dir);
  if (loaded.status === "corrupt") warnings.push(loaded.warning);
  const reported = new Set((loaded.state?.reported_posts ?? []).map((id) => id.toLowerCase()));
  const since =
    parseSince(opts.since, startedAt.getTime()) ??
    (loaded.state?.last_run && !Number.isNaN(Date.parse(loaded.state.last_run)) ? new Date(loaded.state.last_run) : new Date(startedAt.getTime() - 86_400_000));

  // Following, newest first, back to `since`.
  const following = uniq(await collectFollowing(deps.client, since, opts.following_max));
  const followingNew = following.filter((p) => !reported.has(p.id));
  const followingIds = new Set(following.map((p) => p.id));

  // For you: one pass from the top, split by position; extend only if thin.
  const forYouEnd = Math.max(opts.for_you_end, FOR_YOU_START);
  const first = await deps.client.forYouRange(0, forYouEnd);
  const topAll = first.items.filter((p) => p.position < opts.top_picks);
  const topIds = new Set(topAll.map((p) => p.id));
  const topNew = topAll.filter((p) => !reported.has(p.id) && !followingIds.has(p.id));
  const forYouFilter = (list: RankedPost[]) => list.filter((p) => p.position >= FOR_YOU_START && !reported.has(p.id) && !followingIds.has(p.id) && !topIds.has(p.id));
  let forYouAll = first.items.filter((p) => p.position >= FOR_YOU_START);
  let forYouNew = forYouFilter(forYouAll);
  let rangeEnd = forYouEnd;
  if (forYouNew.length < opts.for_you_min && opts.for_you_extend_to > forYouEnd && first.resume) {
    const more = await deps.client.forYouRange(forYouEnd, opts.for_you_extend_to, first.resume);
    const seen = new Set(forYouAll.map((p) => p.id));
    const extra = more.items.filter((p) => !seen.has(p.id));
    forYouAll = [...forYouAll, ...extra];
    forYouNew = [...forYouNew, ...forYouFilter(extra)];
    rangeEnd = opts.for_you_extend_to;
  }
  forYouNew = uniq(forYouNew);

  // Reading history: only used to flag authors and publications the user reads.
  const history = { authors: new Map<string, number>(), publications: new Map<string, number>() };
  if (opts.history > 0) {
    try {
      const page = await deps.client.readingHistory({ limit: opts.history });
      for (const p of page.items.slice(0, opts.history)) {
        if (p.authorUsername) bump(history.authors, `@${p.authorUsername}`);
        if (p.publication) bump(history.publications, p.publication);
      }
    } catch (err) {
      warnings.push(`Reading history unavailable (${err instanceof Error ? err.message : String(err)}); no R flags.`);
    }
  }
  const isRead = (p: PostSummary) =>
    Boolean((p.authorUsername && history.authors.has(`@${p.authorUsername}`)) || (p.publication && history.publications.has(p.publication)));

  const items: RunItem[] = [
    ...toItems("following", followingNew, isRead),
    ...toItems("top", topNew, isRead),
    ...toItems("for_you", forYouNew, isRead),
  ];

  // Rate titles; drop the ones the rater is confident the user wants skipped.
  const interests = await loadInterests(deps.dir);
  const condition = skipCondition(interests);
  let rater: RunFile["rater"];
  if (!items.length) {
    rater = { status: "off", detail: "nothing to rate", threshold: deps.threshold, skipped: 0 };
  } else if (!condition) {
    rater = { status: "off", detail: interests ? "interests.md has no Skip section" : "no interests.md", threshold: deps.threshold, skipped: 0 };
  } else {
    const deadline = startedAt.getTime() + (deps.budgetMs ?? 170_000);
    const result = await deps.rater.rate(
      items.map((i) => ({ title: i.title, subtitle: i.subtitle, author: i.author, publication: i.publication })),
      [condition],
      { deadline },
    );
    let skipped = 0;
    result.ratings.forEach((r, n) => {
      const v = r?.skip;
      if (!v) return;
      items[n]!.rating = v;
      if (v.confidence >= deps.threshold) {
        items[n]!.skipped = true;
        skipped++;
      }
    });
    rater = result.unavailable
      ? { status: "unavailable", detail: result.unavailable, threshold: deps.threshold, skipped: 0 }
      : { status: result.notes.length ? "partial" : "ok", detail: result.notes.join("; ") || undefined, threshold: deps.threshold, skipped };
  }

  const runId = await newRunId(deps.dir, startedAt);
  const run: RunFile = {
    version: 1,
    run_id: runId,
    started_at: isoSeconds(startedAt),
    since: isoSeconds(since),
    member: Boolean(user.membership),
    tz: deps.tz.tz,
    style: deps.style,
    counts: {
      following_new: followingNew.length,
      following_reported: following.length - followingNew.length,
      top: topNew.length,
      top_dropped: topAll.length - topNew.length,
      for_you: forYouNew.length,
      for_you_dropped: forYouAll.length - forYouNew.length,
      for_you_range: [FOR_YOU_START, rangeEnd],
    },
    rater,
    history: { authors: topCounts(history.authors), publications: topCounts(history.publications) },
    warnings,
    items,
  };
  const view = renderView(run, interests, opts.max_chars);
  await writeRun(deps.dir, runId, run);
  await pruneRuns(deps.dir);
  return { run, view };
}

async function collectFollowing(client: MediumClient, since: Date, max: number): Promise<PostSummary[]> {
  const out: PostSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.feed({ source: "following", limit: Math.min(100, max - out.length), since, cursor });
    out.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor && out.length < max);
  return out.slice(0, max);
}

function toItems(pool: Pool, posts: Array<PostSummary & { position?: number }>, isRead: (p: PostSummary) => boolean): RunItem[] {
  return posts.map((p, n) => ({
    ref: `${POOL_PREFIX[pool]}${n + 1}`,
    id: p.id,
    pool,
    title: p.title,
    subtitle: p.subtitle,
    author: p.author,
    authorUsername: p.authorUsername,
    publication: p.publication,
    url: p.url,
    minutes: p.readingMinutes,
    claps: p.claps,
    memberOnly: p.memberOnly,
    reason: pool === "following" ? undefined : p.reason,
    position: p.position,
    read: isRead(p),
  }));
}

function uniq<T extends { id: string }>(list: T[]): T[] {
  const seen = new Set<string>();
  return list.filter((p) => !seen.has(p.id) && Boolean(seen.add(p.id)));
}

function bump(m: Map<string, number>, key: string): void {
  m.set(key, (m.get(key) ?? 0) + 1);
}

function topCounts(m: Map<string, number>, n = 8): Array<[string, number]> {
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

// ---- the view digest_begin returns ----

function itemLine(i: RunItem): string {
  const flags = [i.memberOnly ? "M" : "", i.read ? "R" : ""].join("") || "-";
  const cols = [i.ref, cut(i.title, 90), i.author ?? "-", i.publication ?? "-", i.minutes ?? "-", formatClaps(i.claps), flags];
  if (i.pool !== "following") cols.push(shortReason(i.reason) ?? "-");
  return cols.join(" | ");
}

export function raterLine(r: RunFile["rater"]): string {
  const pct = `${Math.round(r.threshold * 100)}%`;
  if (r.status === "off") return `Rater: off (${r.detail}); nothing skipped`;
  if (r.status === "unavailable") return `Rater: unavailable (${r.detail}); nothing skipped`;
  return `Rater: ${r.skipped} skipped (threshold ${pct})${r.status === "partial" ? `; ${r.detail}` : ""}`;
}

/**
 * Plain-text work list. Over `maxChars`, the tail of For you goes first, then
 * the tail of Following; omitted items are marked in the run so Following ones
 * still land in "Also new".
 */
export function renderView(run: RunFile, interests: Interests | null, maxChars: number): string {
  const c = run.counts;
  const head = [
    `Medium digest run ${run.run_id} · member: ${run.member ? "yes" : "no"}`,
    `Since: ${formatLocal(run.since, run.tz)} (${run.since})`,
    `Following: ${c.following_new} new (${c.following_reported} already reported) · Top picks: ${c.top} (${c.top_dropped} dropped) · ` +
      `For you: ${c.for_you} from positions ${c.for_you_range[0]}–${c.for_you_range[1]} (${c.for_you_dropped} dropped)`,
    raterLine(run.rater),
  ];
  const read = [run.history.authors, run.history.publications].map((l) => l.map(([k, n]) => `${k} ×${n}`).join(", ")).filter(Boolean);
  if (read.length) head.push(`You read: ${read.join(" | ")}`);
  if (interests?.interests) head.push(`Interests:\n${cut3000(interests.interests)}`);
  if (run.warnings.length) head.push(`Warnings: ${run.warnings.join(" ")}`);

  const visible = run.items.filter((i) => !i.skipped);
  if (!visible.length) return [...head, "", "Nothing new. Call digest_finish with no items."].join("\n");

  head.push("Columns: ref | title | author | publication | minutes | claps | flags (M member-only, R you read this author/publication) [| reason]");
  const sections: Array<{ title: string; items: RunItem[] }> = [
    { title: "## Following", items: visible.filter((i) => i.pool === "following") },
    { title: "## Top picks", items: visible.filter((i) => i.pool === "top") },
    { title: "## For you", items: visible.filter((i) => i.pool === "for_you") },
  ];
  const skipped = run.items.filter((i) => i.skipped);
  let skippedText = skipped.length ? `## Skipped by rater\n${skipped.map((i) => `${i.ref} ${cut(i.title, 50)}`).join(" · ")}` : "";
  if (skippedText.length > 4000) skippedText = skippedText.slice(0, 3990).replace(/ · [^·]*$/, "") + " · …";
  const tail = "Next: shortlist ≤10 F, ≤5 T, ≤10 Y refs; read them with subagents (read_post accepts the ref); then call digest_finish.";

  const lines = new Map(run.items.map((i) => [i.ref, itemLine(i)]));
  const reserve = "(F999–F999, Y999–Y999 omitted for size)".length + 1;
  let size =
    [...head, skippedText, tail].join("\n").length +
    reserve +
    sections.reduce((n, s) => n + (s.items.length ? s.title.length + 1 : 0) + s.items.reduce((m, i) => m + lines.get(i.ref)!.length + 1, 0), 0);
  const omitted: RunItem[] = [];
  // For you's tail goes first, then Following's, but each keeps a floor before
  // the other is cut further, so the model always has some of both. Top picks last.
  const [fol, top, you] = sections as [(typeof sections)[0], (typeof sections)[0], (typeof sections)[0]];
  const phases: Array<[(typeof sections)[0], number]> = [[you, 25], [fol, 50], [you, 0], [fol, 0], [top, 0]];
  for (const [s, floor] of phases) {
    while (s.items.length > floor && size > maxChars) {
      const gone = s.items.pop()!;
      size -= lines.get(gone.ref)!.length + 1 + (s.items.length ? 0 : s.title.length + 1);
      omitted.push(gone);
    }
  }
  for (const i of omitted) i.omitted = true;

  const body: string[] = [];
  for (const s of sections) {
    if (s.items.length) body.push(s.title, ...s.items.map((i) => lines.get(i.ref)!));
  }
  const omittedByPool = (["following", "top", "for_you"] as const)
    .map((p) => omitted.filter((i) => i.pool === p).sort((a, b) => Number(a.ref.slice(1)) - Number(b.ref.slice(1))))
    .filter((l) => l.length)
    .map((l) => `${l[0]!.ref}–${l[l.length - 1]!.ref}`);
  if (omittedByPool.length) body.push(`(${omittedByPool.join(", ")} omitted for size)`);
  return [...head, ...body, ...(skippedText ? [skippedText] : []), tail].join("\n");
}

function cut3000(s: string): string {
  return s.length > 3000 ? s.slice(0, 2990) + " …" : s;
}
