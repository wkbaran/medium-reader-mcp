import { GRAPHQL_URL, SESSION_COOKIE, USER_AGENT, USER_COOKIE } from "../config.js";
import type { Session } from "../auth/credentials.js";

export class MediumError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "MediumError";
  }
}

/** The request needed a login and either none was configured or Medium rejected it. */
export class AuthError extends MediumError {
  constructor(readonly reason: "missing" | "expired") {
    super(
      reason === "missing"
        ? "Not logged in to Medium. Run `medium-reader-mcp login` in a terminal, then retry."
        : "Your Medium session was rejected (expired or signed out). Run `medium-reader-mcp login` in a terminal to refresh it, then retry.",
      401,
    );
    this.name = "AuthError";
  }
}

/** Cloudflare answered with its challenge page instead of letting the request through. */
export class BlockedError extends MediumError {
  constructor(status: number) {
    super(
      `Medium's Cloudflare protection blocked the request (HTTP ${status}). This is usually temporary; wait a minute and retry. If it keeps happening, see Troubleshooting in the README.`,
      status,
    );
    this.name = "BlockedError";
  }
}

export type FetchLike = typeof fetch;

export interface HttpOptions {
  session?: Session;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  /** Injected so tests don't actually wait on backoff. */
  sleep?: (ms: number) => Promise<void>;
}

export interface GqlError {
  message: string;
  path?: Array<string | number>;
  extensions?: { code?: string };
}

export interface GqlOptions {
  /** Fail fast without a session. */
  requireAuth?: boolean;
  /** Mutations are never retried: they may have gone through. */
  mutation?: boolean;
}

/**
 * Talks to Medium's web GraphQL endpoint (the one medium.com itself uses).
 * It accepts ad-hoc query text in a batched body: `[{operationName, query, variables}]`.
 * The session cookies are only ever sent to medium.com.
 */
export class MediumHttp {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: HttpOptions = {}) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get authenticated(): boolean {
    return Boolean(this.opts.session?.sid);
  }

  /** Run one operation and return its `data`. GraphQL errors become MediumError. */
  async gql<T>(query: string, variables: Record<string, unknown> = {}, opts: GqlOptions = {}): Promise<T> {
    if (opts.requireAuth && !this.authenticated) throw new AuthError("missing");
    const operationName = query.match(/^\s*(?:query|mutation)\s+(\w+)/)?.[1] ?? null;
    const body = JSON.stringify([{ operationName, query, variables }]);

    const res = await this.request(body, opts.mutation ?? /^\s*mutation\b/.test(query));
    const text = await res.text();
    if (res.status === 401) throw new AuthError(this.authenticated ? "expired" : "missing");
    if (res.status === 403 || res.status === 503) {
      if (/<html|cloudflare|cf-ray/i.test(text)) throw new BlockedError(res.status);
    }
    if (!res.ok) throw new MediumError(`Medium returned HTTP ${res.status}${detail(text)}`, res.status);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new MediumError(`Medium returned something that isn't JSON (HTTP ${res.status}).`, res.status);
    }
    const result = (Array.isArray(parsed) ? parsed[0] : parsed) as { data?: T; errors?: GqlError[] } | undefined;
    if (result?.errors?.length) {
      const messages = result.errors.map((e) => e.message);
      if (result.errors.some(isAuthError)) throw new AuthError(this.authenticated ? "expired" : "missing");
      // Partial data with errors (e.g. one missing nested object) is still useful.
      if (result.data && Object.values(result.data).some((v) => v != null)) return result.data;
      throw new MediumError(`Medium GraphQL error: ${messages.join("; ")}`);
    }
    if (!result?.data) throw new MediumError("Medium returned an empty GraphQL response.");
    return result.data;
  }

  private async request(body: string, isMutation: boolean): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(GRAPHQL_URL, {
          method: "POST",
          headers: this.headers(),
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (!isMutation && attempt < this.maxRetries && isTransient(err)) {
          await this.sleep(backoff(attempt));
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new MediumError(`Request to Medium failed: ${msg}`);
      }
      const retryable = res.status === 429 || (!isMutation && res.status >= 500);
      if (retryable && attempt < this.maxRetries) {
        await res.body?.cancel();
        await this.sleep(retryAfterMs(res) ?? backoff(attempt));
        continue;
      }
      return res;
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: "https://medium.com",
      Referer: "https://medium.com/",
    };
    const s = this.opts.session;
    if (s?.sid) {
      headers.Cookie = [`${SESSION_COOKIE}=${s.sid}`, s.uid ? `${USER_COOKIE}=${s.uid}` : null].filter(Boolean).join("; ");
    }
    return headers;
  }
}

function isAuthError(e: GqlError): boolean {
  return e.extensions?.code === "UNAUTHENTICATED" || /not (logged|signed) in|must be logged in|unauthori[sz]ed/i.test(e.message);
}

function isTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === "TimeoutError" ||
    err.name === "AbortError" ||
    /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(err.message + String((err as { cause?: unknown }).cause ?? ""))
  );
}

function backoff(attempt: number): number {
  return 500 * 2 ** attempt;
}

function retryAfterMs(res: Response): number | null {
  const value = res.headers.get("retry-after");
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.min(secs * 1000, 30_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.min(Math.max(date - Date.now(), 0), 30_000);
}

function detail(text: string): string {
  try {
    const parsed = JSON.parse(text) as { errors?: GqlError[] } | Array<{ errors?: GqlError[] }>;
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    const msg = first?.errors?.[0]?.message;
    return msg ? ` (${msg})` : "";
  } catch {
    return "";
  }
}
