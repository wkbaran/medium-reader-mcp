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
