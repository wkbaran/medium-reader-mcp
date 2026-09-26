import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { paths, SESSION_COOKIE, USER_COOKIE } from "../config.js";

export interface MediumUser {
  id: string;
  name?: string;
  username?: string;
  /** Medium membership tier ("MEMBER", "FRIEND", ...) when the account has one. */
  membership?: string | null;
}

/** The cookies that make up a Medium session. */
export interface Session {
  sid: string;
  uid?: string;
}

export interface Credentials extends Session {
  /** Where the credentials came from, for status messages. */
  source: "env" | "auth-file";
  /** Cookie expiry (ISO) when known. */
  expiresAt?: string;
  savedAt?: string;
  user?: MediumUser;
}

interface AuthFile {
  version: 1;
  sid: string;
  uid?: string;
  expiresAt?: string;
  savedAt: string;
  user?: MediumUser;
}

/**
 * Resolve credentials in priority order:
 *   1. MEDIUM_SID env var (with optional MEDIUM_UID), or MEDIUM_COOKIE holding a full Cookie header
 *   2. auth.json written by `medium-reader-mcp login`
 */
export async function loadCredentials(): Promise<Credentials | null> {
  if (process.env.MEDIUM_SID) {
    return { sid: process.env.MEDIUM_SID, uid: process.env.MEDIUM_UID || undefined, source: "env" };
  }
  const fromHeader = extractSession(process.env.MEDIUM_COOKIE ?? "");
  if (fromHeader) return { ...fromHeader, source: "env" };

  const file = await readJson<AuthFile>(paths.auth);
  if (file?.sid) {
    return {
      sid: file.sid,
      uid: file.uid,
      source: "auth-file",
      expiresAt: file.expiresAt,
      savedAt: file.savedAt,
      user: file.user,
    };
  }
  return null;
}

export async function saveCredentials(creds: Session & { expiresAt?: string; user?: MediumUser }): Promise<string> {
  const file: AuthFile = {
    version: 1,
    sid: creds.sid,
    uid: creds.uid,
    expiresAt: creds.expiresAt,
    savedAt: new Date().toISOString(),
    user: creds.user,
  };
  const target = paths.auth;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  // Write-then-rename so a crash never leaves a half-written session file.
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, target);
  return target;
}

export async function clearCredentials(): Promise<boolean> {
  try {
    await rm(paths.auth);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pull the Medium session cookies out of whatever the user pasted:
 * a Cookie-Editor / EditThisCookie JSON export, a raw `Cookie:` header,
 * a Netscape cookies.txt, or just the bare `sid` value.
 */
export function extractSession(input: string): Session | null {
  const text = input.trim();
  if (!text) return null;
  const found = new Map<string, string>();

  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text);
      const list = Array.isArray(parsed) ? parsed : ((parsed as { cookies?: unknown[] }).cookies ?? []);
      for (const c of list as Array<{ name?: string; value?: string; domain?: string }>) {
        if (!c?.name || !c.value) continue;
        // Only medium.com's own cookies; a full-browser export has other sites' `sid`s too.
        if (c.domain && !/(^|\.)medium\.com$/i.test(c.domain.replace(/^\./, ""))) continue;
        found.set(c.name, c.value.trim());
      }
    } catch {
      return null;
    }
    return toSession(found);
  }

  // Netscape cookies.txt: tab-separated; domain in column 1, name in column 6, value in column 7.
  let sawCookiesTxt = false;
  for (const line of text.split(/\r?\n/)) {
    const cols = line.split("\t");
    if (cols.length < 7) continue;
    sawCookiesTxt = true;
    if (!/(^|\.)medium\.com$/i.test(cols[0]!.replace(/^#HttpOnly_/, "").replace(/^\./, ""))) continue;
    found.set(cols[5]!, cols[6]!.trim());
  }
  if (sawCookiesTxt) return toSession(found);

  // Cookie header ("Cookie: a=b; sid=...; uid=...") or "sid=..."
  const header = text.replace(/^cookie:\s*/i, "");
  if (/(?:^|[;\s])sid=/.test(header)) {
    for (const part of header.split(/;\s*/)) {
      const eq = part.indexOf("=");
      if (eq > 0) found.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
    return toSession(found);
  }

  // Bare value: Medium sids look like "1:<base64-ish>".
  if (/^\d+:[\w\-%.+/=]+$/.test(text)) return { sid: text };

  return null;
}

function toSession(cookies: Map<string, string>): Session | null {
  const sid = cookies.get(SESSION_COOKIE);
  if (!sid) return null;
  const uid = cookies.get(USER_COOKIE);
  return uid ? { sid, uid } : { sid };
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}
