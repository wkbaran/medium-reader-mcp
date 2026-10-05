import { homedir } from "node:os";
import { join } from "node:path";

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
