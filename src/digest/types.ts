export type Pool = "following" | "top" | "for_you";

export const POOL_PREFIX: Record<Pool, "F" | "T" | "Y"> = { following: "F", top: "T", for_you: "Y" };

/** One post as digest_begin saw it. Saved in the run file. */
export interface RunItem {
  /** `F1`, `T3`, `Y12`. */
  ref: string;
  id: string;
  pool: Pool;
  title: string;
  subtitle?: string;
  author?: string;
  authorUsername?: string;
  publication?: string;
  url?: string;
  minutes?: number;
  claps?: number;
  memberOnly: boolean;
  /** Medium's reason for showing it (For you only). */
  reason?: string;
  /** Position in the For you list. */
  position?: number;
  /** The user has read this author or publication recently (reading history). */
  read: boolean;
  /** The classifier's `skip` verdict, when it gave one. */
  rating?: { confidence: number; reason?: string };
  /** The classifier's rank, 0–1 (higher = more wanted), when the backend ranks. */
  rank?: number;
  /** Dropped by the classifier (skip confidence ≥ threshold). */
  skipped?: boolean;
  /** Ranked below the rank floor: listed in one compact line instead of a full row. Still committed and listed in "Also new". */
  low?: boolean;
  /** Left out of the view to keep it under max_chars. Still committed and listed in "Also new". */
  omitted?: boolean;
}

export interface Judgment {
  ref: string;
  gist: string;
  why?: string;
}

/** What the model decided, with refs resolved to canonical form (`F3`). */
export interface Judgments {
  starred: Judgment[];
  following: Judgment[];
  top_picks: Judgment[];
  for_you: Judgment[];
  preview_only: string[];
  unreadable: string[];
  extra_skipped: string[];
}

export interface RunFile {
  version: 1;
  run_id: string;
  /** Server clock when digest_begin started fetching; becomes last_run on commit. */
  started_at: string;
  since: string;
  member: boolean;
  tz: string;
  style: "discord" | "markdown";
  counts: {
    following_new: number;
    following_reported: number;
    top: number;
    top_dropped: number;
    for_you: number;
    for_you_dropped: number;
    for_you_range: [number, number];
  };
  /** The headline classifier's outcome. (Named `rater` for compatibility with older run files.) */
  rater: {
    status: "ok" | "partial" | "unavailable" | "off";
    detail?: string;
    threshold: number;
    skipped: number;
    /** Backend name, e.g. "sampling" or "jev (typesafe/jev-1.13)". */
    classifier?: string;
    /** How many items got a rank (0 when the backend doesn't rank). */
    ranked?: number;
    /** Rank floor in effect (0 = off) and how many items fell below it. */
    floor?: number;
    low?: number;
  };
  history: { authors: Array<[string, number]>; publications: Array<[string, number]> };
  warnings: string[];
  items: RunItem[];
  committed_at?: string;
  judgments?: Judgments;
  commit_summary?: string;
}
