import type { FetchLike } from "../src/medium/http.js";

export interface GqlRequest {
  operationName: string | null;
  query: string;
  variables: Record<string, unknown>;
  cookie: string | null;
  headers: Headers;
}

export interface Reply {
  status?: number;
  /** GraphQL `data`. Wrapped as Medium does: `[{ data }]`. */
  data?: unknown;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
  /** A raw body instead of a GraphQL envelope (e.g. Cloudflare's HTML). */
  raw?: string;
  headers?: Record<string, string>;
}

type Handler = Reply | ((req: GqlRequest) => Reply);

/**
 * A fake of medium.com/_/graphql keyed by operation name. Records every
 * request with the Cookie header it carried.
 */
export function fakeMedium(handlers: Record<string, Handler>) {
  const requests: GqlRequest[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    if (url !== "https://medium.com/_/graphql") return new Response("unexpected url " + url, { status: 599 });
    const headers = new Headers(init?.headers);
    const [op] = JSON.parse(String(init?.body)) as Array<{ operationName: string | null; query: string; variables: Record<string, unknown> }>;
    const req: GqlRequest = { ...op!, cookie: headers.get("cookie"), headers };
    requests.push(req);
    const h = handlers[op!.operationName ?? ""];
    const r = typeof h === "function" ? h(req) : h;
    if (!r) return new Response(JSON.stringify([{ errors: [{ message: `no handler for ${op!.operationName}` }] }]), { status: 200 });
    const body = r.raw ?? JSON.stringify([{ data: r.data, ...(r.errors ? { errors: r.errors } : {}) }]);
    return new Response(body, { status: r.status ?? 200, headers: r.headers });
  };
  return { fetch, requests };
}

export const SESSION = { sid: "1:test-session", uid: "user0000001" };

/** Only answers as logged in when the request carries both session cookies. */
export function asViewer(data: unknown, loggedOut: unknown = { viewer: null }): (req: GqlRequest) => Reply {
  return (req) => ({ data: req.cookie === `sid=${SESSION.sid}; uid=${SESSION.uid}` ? data : loggedOut });
}

export const VIEWER = { viewer: { id: SESSION.uid, name: "Test User", username: "tester", membership: { tier: "MEMBER" } } };

export function rawPost(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `Post ${id}`,
    mediumUrl: `https://medium.com/@someone/post-${id}`,
    isLocked: false,
    firstPublishedAt: Date.UTC(2026, 8, 20),
    readingTime: 4.2,
    clapCount: 10,
    creator: { id: "author1", name: "Some One", username: "someone" },
    collection: null,
    extendedPreviewContent: { subtitle: "sub" },
    ...extra,
  };
}
