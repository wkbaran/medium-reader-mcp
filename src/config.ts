import { homedir } from "node:os";
import { join } from "node:path";
import { parseDuration } from "paced-fetch";

/** Root directory for everything this tool persists. Override with MEDIUM_READER_HOME. */
export function configDir(): string {
  if (process.env.MEDIUM_READER_HOME) return process.env.MEDIUM_READER_HOME;
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "medium-reader");
}

export const paths = {
  get auth() {
    return join(configDir(), "auth.json");
  },
  get browserProfile() {
    return join(configDir(), "browser-profile");
  },
};

/** Medium's login cookie. `uid` identifies the account and is sent alongside it. */
export const SESSION_COOKIE = "sid";
export const USER_COOKIE = "uid";

export const GRAPHQL_URL = "https://medium.com/_/graphql";

/**
 * Cloudflare in front of medium.com rejects requests without a browser-like
 * User-Agent (and headless Chrome's "HeadlessChrome" UA). Node's fetch with this
 * UA gets through; see CLAUDE.md.
 */
export const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

// ---- digest mode (opt-in; see README "Daily digest with Hermes Agent") ----

/** Directory holding the digest's state.json, interests.md and runs/. Unset hides the digest tools. */
export function digestDir(): string | undefined {
  const dir = process.env.MEDIUM_READER_DIGEST_DIR?.trim();
  return dir ? dir : undefined;
}

/** True when `tz` is an IANA zone name Intl understands. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Time zone for dates shown in the digest: MEDIUM_READER_DIGEST_TZ, then TZ,
 * then UTC. An invalid name falls back to UTC with a warning.
 */
export function digestTimezone(): { tz: string; warning?: string } {
  for (const name of ["MEDIUM_READER_DIGEST_TZ", "TZ"] as const) {
    const tz = process.env[name]?.trim();
    if (!tz) continue;
    if (isValidTimeZone(tz)) return { tz };
    return { tz: "UTC", warning: `${name}="${tz}" isn't a time zone name; using UTC.` };
  }
  return { tz: "UTC" };
}

function envNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/** How many reported post ids state.json keeps (newest). */
/**
 * How long digest_begin may spend, fetching and rating included (MEDIUM_READER_DIGEST_FETCH_BUDGET,
 * e.g. "10min"). The default, 170 s, fits an agent host's 300 s tool timeout.
 */
export function digestFetchBudget(env: NodeJS.ProcessEnv = process.env): { ms: number; warning?: string } {
  const raw = env.MEDIUM_READER_DIGEST_FETCH_BUDGET?.trim();
  const parsed = raw ? parseDuration(raw) : null;
  if (!raw) return { ms: 170_000 };
  if (parsed && parsed >= 30_000) return { ms: parsed };
  return { ms: 170_000, warning: `MEDIUM_READER_DIGEST_FETCH_BUDGET=${raw} isn't a duration of at least 30 s; using 170 s.` };
}

/** Lengths and counts digest_finish allows; longer text is cut at a clause or word break, with a warning. */
export interface DigestLimits {
  /** ⭐ picks at most; extras move to their section. */
  starred: number;
  /** Characters in a ⭐ pick's gist. */
  starGist: number;
  /** Characters in a ⭐ pick's why line. */
  why: number;
  /** Characters in a section post's one-line gist. */
  gist: number;
}

/**
 * MEDIUM_READER_DIGEST_MAX_STARRED (8), _STAR_GIST_MAX (400), _WHY_MAX (250) and
 * _GIST_MAX (280). The values are also written into digest_finish's argument
 * descriptions and returned by digest_begin, so a client's prompt can use them.
 */
export function digestLimits(): DigestLimits {
  return {
    starred: Math.round(envNumber("MEDIUM_READER_DIGEST_MAX_STARRED", 8, 1, 30)),
    starGist: Math.round(envNumber("MEDIUM_READER_DIGEST_STAR_GIST_MAX", 400, 80, 2000)),
    why: Math.round(envNumber("MEDIUM_READER_DIGEST_WHY_MAX", 250, 40, 1000)),
    gist: Math.round(envNumber("MEDIUM_READER_DIGEST_GIST_MAX", 280, 60, 1000)),
  };
}

export function digestKeep(): number {
  return Math.round(envNumber("MEDIUM_READER_DIGEST_KEEP", 3000, 100, 100_000));
}

/** Link style for the rendered digest: Discord wraps masked-link URLs in <> to stop embeds. */
export function digestStyle(): "discord" | "markdown" {
  return process.env.MEDIUM_READER_DIGEST_STYLE?.trim().toLowerCase() === "markdown" ? "markdown" : "discord";
}

/** Titles the rater gives a `skip` confidence at or above this are dropped. */
export function digestSkipThreshold(): number {
  return envNumber("MEDIUM_READER_DIGEST_SKIP_THRESHOLD", 0.7, 0, 1);
}

/** Rank below which a post is listed in one compact line instead of a full row (0 = off). Only with a ranking classifier. */
export function digestRankFloor(): number {
  return envNumber("MEDIUM_READER_DIGEST_RANK_FLOOR", 0, 0, 1);
}

/**
 * What happens to posts below the rank floor. `compact` (default): one compact line in the work list, still valid refs,
 * Following ones still under "Also new". `exclude`: left out of the work list and the digest, only counted.
 */
export function digestRankFloorMode(): "compact" | "exclude" {
  return process.env.MEDIUM_READER_DIGEST_RANK_FLOOR_MODE?.trim().toLowerCase() === "exclude" ? "exclude" : "compact";
}

export const DIGEST_FILES = {
  state: "state.json",
  interests: "interests.md",
  runs: "runs",
} as const;
