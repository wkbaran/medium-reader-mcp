import { createInterface } from "node:readline/promises";
import { mkdir } from "node:fs/promises";
import { paths, SESSION_COOKIE, USER_COOKIE } from "../config.js";
import { MediumClient } from "../medium/api.js";
import { AuthError, MediumHttp } from "../medium/http.js";
import { extractSession, saveCredentials, type MediumUser, type Session } from "./credentials.js";

export interface LoginResult {
  user: MediumUser;
  file: string;
  expiresAt?: string;
}

/** Check a session against Medium and persist it only if it actually works. */
export async function validateAndSave(session: Session, expiresAt?: string): Promise<LoginResult> {
  if (!session.uid) {
    // Medium serves requests carrying only `sid` as logged out.
    throw new Error('Medium needs both the "sid" and "uid" cookies. Paste a full Cookie header or a Cookie-Editor export instead of the bare value.');
  }
  const user = await verifySession(session);
  if (!user) {
    throw new Error("Medium rejected that session. Make sure you copied the cookies while logged in.");
  }
  const file = await saveCredentials({ ...session, expiresAt, user });
  return { user, file, expiresAt };
}

async function verifySession(session: Session): Promise<MediumUser | null> {
  try {
    return await new MediumClient(new MediumHttp({ session, maxRetries: 1 })).whoami();
  } catch (err) {
    if (err instanceof AuthError) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Browser login
// ---------------------------------------------------------------------------

type PlaywrightChromium = typeof import("playwright-core").chromium;
type BrowserContext = import("playwright-core").BrowserContext;

export class BrowserUnavailableError extends Error {}

/**
 * Open a real browser window on Medium's sign-in page and wait for the user to
 * log in (email code, Google, Apple — whatever they normally use). The session
 * cookies are captured as soon as Medium accepts them.
 *
 * The window must be headed: Cloudflare blocks headless Chrome on medium.com.
 * A dedicated browser profile is kept under the config dir, so when the session
 * eventually expires, re-running login usually completes without typing anything.
 */
export async function browserLogin({ timeoutMs = 5 * 60_000, log = console.error } = {}): Promise<LoginResult> {
  const chromium = await loadChromium();
  await mkdir(paths.browserProfile, { recursive: true, mode: 0o700 });
  const context = await launch(chromium);

  let closed = false;
  context.on("close", () => {
    closed = true;
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://medium.com/m/signin", { waitUntil: "domcontentloaded" }).catch(() => undefined);
    log("A browser window has opened. Log in to Medium there; this finishes on its own once you're signed in.");
    log("Tip: if Medium emails you a sign-in link, paste that link into the address bar of THIS window.");

    const deadline = Date.now() + timeoutMs;
    let lastSid: string | undefined;
    let lastCheck = 0;
    while (Date.now() < deadline) {
      if (closed) throw new Error("Browser window was closed before login completed.");
      const cookies = await context.cookies("https://medium.com").catch(() => []);
      const sidCookie = cookies.find((c) => c.name === SESSION_COOKIE);
      const uid = cookies.find((c) => c.name === USER_COOKIE)?.value;
      // Re-check when the cookie changes, and periodically in case it was set before login finished.
      if (sidCookie && (sidCookie.value !== lastSid || Date.now() - lastCheck > 5000)) {
        lastSid = sidCookie.value;
        lastCheck = Date.now();
        const session: Session = uid ? { sid: sidCookie.value, uid } : { sid: sidCookie.value };
        const user = await verifySession(session);
        if (user) {
          const expiresAt = sidCookie.expires > 0 ? new Date(sidCookie.expires * 1000).toISOString() : undefined;
          const file = await saveCredentials({ ...session, expiresAt, user });
          return { user, file, expiresAt };
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for login.`);
  } finally {
    if (!closed) await context.close().catch(() => undefined);
  }
}

async function loadChromium(): Promise<PlaywrightChromium> {
  try {
    const mod = await import("playwright-core");
    return mod.chromium;
  } catch {
    throw new BrowserUnavailableError("playwright-core is not installed (it's an optional dependency).");
  }
}

async function launch(chromium: PlaywrightChromium): Promise<BrowserContext> {
  const common = {
    headless: false,
    viewport: null,
    // Keeps "Chrome is being controlled by automated software" and similar flags
    // from tripping Cloudflare's (and Google's) bot checks.
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--disable-blink-features=AutomationControlled"],
  };
  const attempts: Array<{ label: string; opts: Record<string, unknown> }> = [
    { label: "Google Chrome", opts: { channel: "chrome" } },
    { label: "Microsoft Edge", opts: { channel: "msedge" } },
    { label: "Playwright Chromium", opts: {} },
  ];
  if (process.env.MEDIUM_BROWSER_PATH) {
    attempts.unshift({ label: process.env.MEDIUM_BROWSER_PATH, opts: { executablePath: process.env.MEDIUM_BROWSER_PATH } });
  }
  const failures: string[] = [];
  for (const { label, opts } of attempts) {
    try {
      return await chromium.launchPersistentContext(paths.browserProfile, { ...common, ...opts });
    } catch (err) {
      failures.push(`${label}: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`);
    }
  }
  throw new BrowserUnavailableError(
    `Couldn't launch a browser.\n  ${failures.join("\n  ")}\nInstall Chrome, set MEDIUM_BROWSER_PATH, or run \`npx playwright install chromium\`.`,
  );
}

// ---------------------------------------------------------------------------
// Paste login
// ---------------------------------------------------------------------------

export const PASTE_INSTRUCTIONS = `To copy your Medium session cookies:
  1. Log in at https://medium.com in your normal browser.
  2. Open DevTools (F12) → Application (Chrome/Edge) or Storage (Firefox) → Cookies → https://medium.com
  3. Copy the Values of both the "sid" and "uid" cookies (Medium needs both).

You can paste any of: a "Cookie:" header ("sid=...; uid=..."), a Cookie-Editor JSON
export, or a cookies.txt file. It's validated with Medium and stored at
${paths.auth} (mode 600).
`;

/** Read the pasted cookie from an interactive terminal. */
export async function promptForSession(): Promise<Session> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    let buffer = await rl.question("Paste here and press Enter: ");
    // Multi-line JSON exports: keep reading until the paste parses.
    while (/^\s*[[{]/.test(buffer) && !isCompleteJson(buffer)) {
      buffer += "\n" + (await rl.question(""));
    }
    const session = extractSession(buffer);
    if (!session) throw new Error(`Couldn't find a ${SESSION_COOKIE} cookie in what was pasted.`);
    return session;
  } finally {
    rl.close();
  }
}

/** Read the cookie from piped stdin (e.g. `pbpaste | medium-reader-mcp login --stdin`). */
export async function readSessionFromStdin(): Promise<Session> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const session = extractSession(Buffer.concat(chunks).toString("utf8"));
  if (!session) throw new Error(`Couldn't find a ${SESSION_COOKIE} cookie on stdin.`);
  return session;
}

function isCompleteJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
