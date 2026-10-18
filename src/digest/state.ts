import { laterIso, readJson, RunStore, updateJson } from "job-ledger";
import { DIGEST_FILES } from "../config.js";
import type { RunFile } from "./types.js";

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
export const KEEP_RUNS = 14;

/** Run files (`runs/<start time>.json`), the newest KEEP_RUNS kept. */
export function runStore(dir: string): RunStore<RunFile> {
  return new RunStore<RunFile>({ dir, subdir: DIGEST_FILES.runs, keep: KEEP_RUNS });
}

export function validateState(value: unknown): DigestState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const s = value as Record<string, unknown>;
  if (s.reported_posts !== undefined && !Array.isArray(s.reported_posts)) return null;
  if (s.last_run !== undefined && typeof s.last_run !== "string") return null;
  return { ...s, reported_posts: ((s.reported_posts as unknown[]) ?? []).map(String) } as DigestState;
}

/** Read state.json without changing anything. */
export async function loadState(dir: string): Promise<LoadedState> {
  const loaded = await readJson(dir, DIGEST_FILES.state, validateState);
  if (loaded.status === "ok") return { status: "ok", state: loaded.value };
  if (loaded.status === "missing") return { status: "missing", state: null };
  return { status: "corrupt", state: null, warning: "state.json isn't valid state JSON; treating this as a first run (the file is set aside when state is next saved)." };
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

export interface CommitResult {
  added: number;
  alreadyPresent: number;
  total: number;
  lastRun?: string;
  warnings: string[];
}

/**
 * Add ids (and optionally move `last_run` forward) under a lock, then write
 * atomically, copying the old file to state.json.bak first (job-ledger's
 * `updateJson`). The previous file's mode is kept (0644 for a new one).
 */
export async function commitState(dir: string, change: { add: readonly string[]; lastRun?: string; keep: number }): Promise<CommitResult> {
  const { result, warnings } = await updateJson(
    dir,
    DIGEST_FILES.state,
    { validate: validateState, initial: (): DigestState => ({ reported_posts: [] }) },
    (previous) => {
      const notes: string[] = [];
      const before = new Set(previous.reported_posts.map((id) => id.toLowerCase()));
      const toAdd = change.add.map((id) => id.trim().toLowerCase());
      const { ids, dropped } = normalizeIds([...previous.reported_posts, ...toAdd], change.keep);
      if (dropped.length) notes.push(`Dropped ${dropped.length} entries that aren't post ids: ${dropped.slice(0, 5).join(", ")}${dropped.length > 5 ? " …" : ""}`);
      const fresh = new Set(toAdd.filter((id) => POST_ID.test(id)));
      const added = [...fresh].filter((id) => !before.has(id)).length;

      const lastRun = laterIso(previous.last_run, change.lastRun);
      // Keys stay where they were; a new file gets last_run first.
      const next: DigestState = lastRun === undefined ? { ...previous } : { last_run: lastRun, ...previous };
      if (lastRun !== undefined) next.last_run = lastRun;
      next.reported_posts = ids;
      return { value: next, result: { added, alreadyPresent: fresh.size - added, total: ids.length, lastRun, notes } };
    },
  );
  const { notes, ...counts } = result;
  return { ...counts, warnings: [...warnings, ...notes] };
}
