import { pacedFetch, paceFromEnv, RateLimitedError, type PaceOptions } from "paced-fetch";
import { Agent, fetch as undiciFetch } from "undici";
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

/**
 * Cloudflare blocks Node's HTTP/2 client on medium.com, and undici 8 (Node 26's
 * built-in fetch) uses HTTP/2 whenever the server offers it. Pinning our own
 * undici to HTTP/1.1 keeps every Node version working; see CLAUDE.md.
 */
const http1 = new Agent({ allowH2: false });
const http1Fetch = ((input, init) => undiciFetch(input as string, { ...init, dispatcher: http1 } as never)) as FetchLike;

export interface HttpOptions {
  session?: Session;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Retries after a 429, or after a network error or 5xx on a query. Overrides MEDIUM_READER_RETRIES. */
  maxRetries?: number;
  /** Read for MEDIUM_READER_RATE, MEDIUM_READER_CONCURRENCY and the rest (see paced-fetch). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Injected so tests don't actually wait on backoff. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/**
 * Pacing for Medium, which publishes no rate limit: 2 retries, 0.5 s then 1 s
 * (with jitter) or Medium's Retry-After, as before paced-fetch. Every value can
 * be changed with MEDIUM_READER_RATE, MEDIUM_READER_CONCURRENCY,
 * MEDIUM_READER_MIN_GAP, MEDIUM_READER_RETRIES and MEDIUM_READER_MAX_RETRY_WAIT.
 */
export const MEDIUM_PACE: PaceOptions = { retries: 2, backoffMs: [500, 1_000], maxRetryWaitMs: 60_000 };

/** Requests that are mutations, so paced-fetch never sends them twice after a 5xx or network error. */
const mutations = new WeakSet<RequestInit>();

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

  constructor(private readonly opts: HttpOptions = {}) {
    const { pace, warnings } = paceFromEnv("MEDIUM_READER", MEDIUM_PACE, opts.env);
    // stdout is the MCP channel; stderr is where hosts show server logs.
    for (const w of warnings) console.error(w);
    this.fetchImpl = pacedFetch({
      fetch: opts.fetch ?? http1Fetch,
      defaults: { ...pace, ...(opts.maxRetries !== undefined ? { retries: opts.maxRetries } : {}), timeoutMs: opts.timeoutMs ?? 20_000 },
      // Every call is a GraphQL POST; only queries are safe to send twice.
      isIdempotent: (_method, _url, init) => !(init && mutations.has(init)),
      sleep: opts.sleep,
      random: opts.random,
    }) as FetchLike;
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

  /** One GraphQL request, paced and retried by paced-fetch (a mutation only after a 429). */
  private async request(body: string, isMutation: boolean): Promise<Response> {
    const init: RequestInit = { method: "POST", headers: this.headers(), body, redirect: "manual" };
    if (isMutation) mutations.add(init);
    try {
      return await this.fetchImpl(GRAPHQL_URL, init);
    } catch (err) {
      if (err instanceof RateLimitedError) throw new MediumError(`Medium is rate-limiting requests: ${err.message}`, 429);
      const msg = err instanceof Error ? err.message : String(err);
      throw new MediumError(`Request to Medium failed: ${msg}`);
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
