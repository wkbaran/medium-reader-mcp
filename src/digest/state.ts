import { copyFile, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { DIGEST_FILES } from "../config.js";

/**
 * The digest's state file. The schema is the one the original skill wrote by
 * hand, so an existing file keeps working: `last_run` (ISO, UTC) and
 * `reported_posts` (post ids, oldest first). Unknown keys are kept as they are.
 */
export interface DigestState {
  last_run?: string;
  reported_posts: string[];
  [key: string]: unknown;
}

export type LoadedState =
  | { status: "ok"; state: DigestState }
  | { status: "missing"; state: null }
  | { status: "corrupt"; state: null; warning: string };

const POST_ID = /^[0-9a-f]{8,12}$/;
export const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 10_000;
export const KEEP_RUNS = 14;

/** `2026-10-02T12:15:24Z`: ISO without milliseconds, as the state file has always held. */
export function isoSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * A path inside the digest directory. Refuses symlinks and anything whose real
 * location is outside the directory, so a planted link can't redirect a write.
 */
export async function insideDir(dir: string, ...parts: string[]): Promise<string> {
  let root: string;
  try {
    root = await realpath(dir);
  } catch {
    throw new Error(`The digest directory ${dir} doesn't exist. Create it, or fix MEDIUM_READER_DIGEST_DIR.`);
  }
  const target = join(root, ...parts);
  if (target !== root && !target.startsWith(root + sep)) throw new Error(`${parts.join("/")} is outside the digest directory.`);
  const parent = await realpath(dirname(target)).catch(() => null);
  if (parent && parent !== root && !parent.startsWith(root + sep)) throw new Error(`${parts.join("/")} resolves outside the digest directory.`);
  const info = await lstat(target).catch(() => null);
  if (info?.isSymbolicLink()) throw new Error(`Refusing to use ${target}: it's a symlink.`);
  return target;
}

export function parseState(text: string): DigestState | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const s = value as Record<string, unknown>;
  if (s.reported_posts !== undefined && !Array.isArray(s.reported_posts)) return null;
  if (s.last_run !== undefined && typeof s.last_run !== "string") return null;
  return { ...s, reported_posts: ((s.reported_posts as unknown[]) ?? []).map(String) } as DigestState;
}

export function serializeState(s: DigestState): string {
  return JSON.stringify(s, null, 2) + "\n";
}

/** Read state.json without changing anything. */
export async function loadState(dir: string): Promise<LoadedState> {
  const file = await insideDir(dir, DIGEST_FILES.state);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing", state: null };
    throw err;
  }
  const state = parseState(text);
  if (!state) return { status: "corrupt", state: null, warning: "state.json isn't valid state JSON; treating this as a first run (the file is set aside when state is next saved)." };
  return { status: "ok", state };
}

/**
 * Clean the id list: lowercase, drop anything that isn't an 8–12 hex post id,
 * de-duplicate keeping the *last* occurrence (so a re-reported post counts as
 * new), and keep the newest `keep`.
 */
export function normalizeIds(ids: readonly string[], keep: number): { ids: string[]; dropped: string[] } {
  const dropped: string[] = [];
  const lastIndex = new Map<string, number>();
  const clean = ids.map((raw) => {
    const id = String(raw).trim().toLowerCase();
    if (!POST_ID.test(id)) dropped.push(String(raw));
    return id;
  });
  clean.forEach((id, i) => POST_ID.test(id) && lastIndex.set(id, i));
  const out = clean.filter((id, i) => lastIndex.get(id) === i);
  return { ids: out.length > keep ? out.slice(out.length - keep) : out, dropped };
}

/** The later of two ISO times; `last_run` never moves backwards. */
export function laterIso(a: string | undefined, b: string | undefined): string | undefined {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  if (Number.isNaN(ta)) return Number.isNaN(tb) ? (a ?? b) : b;
  if (Number.isNaN(tb)) return a;
  return tb > ta ? b : a;
}

export interface CommitResult {
  added: number;
  alreadyPresent: number;
  total: number;
  lastRun?: string;
  warnings: string[];
}

/**
 * Add ids (and optionally move `last_run` forward) under a lock, then write
 * atomically: copy the old file to state.json.bak, write state.json.tmp-<pid>,
 * rename over state.json. The previous file's mode is kept (0644 for a new one).
 */
export async function commitState(dir: string, change: { add: readonly string[]; lastRun?: string; keep: number }): Promise<CommitResult> {
  const file = await insideDir(dir, DIGEST_FILES.state);
  const warnings: string[] = [];
  return withLock(file + ".lock", async () => {
    let previous: DigestState = { reported_posts: [] };
    let mode = 0o644;
    let existing: string | null = null;
    try {
      existing = await readFile(file, "utf8");
      mode = (await stat(file)).mode & 0o777;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (existing !== null) {
      const parsed = parseState(existing);
      if (parsed) {
        previous = parsed;
      } else {
        const aside = await insideDir(dir, `${DIGEST_FILES.state}.corrupt-${isoSeconds(new Date()).replace(/[-:]/g, "")}`);
        await rename(file, aside);
        warnings.push(`state.json was corrupt; moved it to ${aside.split(sep).pop()} and started a new one.`);
        existing = null;
      }
    }

    const before = new Set(previous.reported_posts.map((id) => id.toLowerCase()));
    const toAdd = change.add.map((id) => id.trim().toLowerCase());
    const { ids, dropped } = normalizeIds([...previous.reported_posts, ...toAdd], change.keep);
    if (dropped.length) warnings.push(`Dropped ${dropped.length} entries that aren't post ids: ${dropped.slice(0, 5).join(", ")}${dropped.length > 5 ? " …" : ""}`);
    const fresh = new Set(toAdd.filter((id) => POST_ID.test(id)));
    const added = [...fresh].filter((id) => !before.has(id)).length;

    const lastRun = laterIso(previous.last_run, change.lastRun);
    // Keys stay where they were; a new file gets last_run first.
    const next: DigestState = lastRun === undefined ? { ...previous } : { last_run: lastRun, ...previous };
    if (lastRun !== undefined) next.last_run = lastRun;
    next.reported_posts = ids;
    await writeState(dir, file, next, existing, mode);
    return { added, alreadyPresent: fresh.size - added, total: ids.length, lastRun, warnings };
  });
}

async function writeState(dir: string, file: string, s: DigestState, existing: string | null, mode: number): Promise<void> {
  const text = serializeState(s);
  if (existing === text) return;
  if (existing !== null) await copyFile(file, await insideDir(dir, `${DIGEST_FILES.state}.bak`));
  await writeAtomic(file, text, mode);
}

/** Write via `<file>.tmp-<pid>` and rename, so readers never see half a file. */
export async function writeAtomic(file: string, text: string, mode = 0o644): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, text, { mode });
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/**
 * Run `fn` holding an exclusive lock file. A lock older than LOCK_STALE_MS is
 * assumed to belong to a dead process and is removed.
 */
export async function withLock<T>(lockFile: string, fn: () => Promise<T>, opts: { staleMs?: number; waitMs?: number } = {}): Promise<T> {
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const deadline = Date.now() + (opts.waitMs ?? LOCK_WAIT_MS);
  for (;;) {
    try {
      const handle = await open(lockFile, "wx");
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
      await handle.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const info = await stat(lockFile).catch(() => null);
      if (info && Date.now() - info.mtimeMs > staleMs) {
        await rm(lockFile, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`${lockFile.split(sep).pop()} is held by another run; try again in a minute.`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockFile, { force: true });
  }
}

// ---- run files ----

const RUN_ID = /^\d{8}T\d{6}Z(?:-\d+)?$/;

export function runIdFor(d: Date): string {
  return isoSeconds(d).replace(/[-:]/g, "");
}

async function runsDir(dir: string): Promise<string> {
  const runs = await insideDir(dir, DIGEST_FILES.runs);
  await mkdir(runs, { recursive: true });
  return runs;
}

/** Run ids, oldest first. */
export async function listRunIds(dir: string): Promise<string[]> {
  const runs = await insideDir(dir, DIGEST_FILES.runs);
  const names = await readdir(runs).catch(() => [] as string[]);
  return names
    .filter((n) => n.endsWith(".json") && RUN_ID.test(n.slice(0, -5)))
    .map((n) => n.slice(0, -5))
    .sort(compareRunIds);
}

function compareRunIds(a: string, b: string): number {
  const [ba, sa] = a.split("-");
  const [bb, sb] = b.split("-");
  return ba! < bb! ? -1 : ba! > bb! ? 1 : Number(sa ?? 1) - Number(sb ?? 1);
}

export async function readRun<T>(dir: string, id: string): Promise<T | null> {
  if (!RUN_ID.test(id)) return null;
  const file = await insideDir(dir, DIGEST_FILES.runs, `${id}.json`);
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** A run id not used yet for this start time (`…Z`, then `…Z-2`, …). */
export async function newRunId(dir: string, startedAt: Date): Promise<string> {
  const base = runIdFor(startedAt);
  const taken = new Set(await listRunIds(dir));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export async function writeRun(dir: string, id: string, run: unknown): Promise<void> {
  await runsDir(dir);
  const file = await insideDir(dir, DIGEST_FILES.runs, `${id}.json`);
  await writeAtomic(file, JSON.stringify(run, null, 2) + "\n");
}

/** Delete all but the newest `keep` run files. */
export async function pruneRuns(dir: string, keep = KEEP_RUNS): Promise<void> {
  const ids = await listRunIds(dir);
  for (const id of ids.slice(0, Math.max(0, ids.length - keep))) {
    await rm(await insideDir(dir, DIGEST_FILES.runs, `${id}.json`), { force: true });
  }
}
