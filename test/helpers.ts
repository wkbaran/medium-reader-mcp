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

/**
 * A fake "For you" list served 25 at a time the way Medium pages it
 * (`to` = offset, a fixed `source`). Throws if asked for offset 250 or beyond,
 * which would rebuild the user's homepage list.
 */
export function forYouList(posts: Array<Record<string, unknown>>, reason: (i: number) => string = (i) => (i % 2 ? "Based on your reading history" : "Because you follow Coding")) {
  return (req: GqlRequest): Reply => {
    const paging = req.variables.paging as { to?: string; source?: string; limit?: number };
    const offset = Number(paging.to ?? 0);
    if (offset >= 250) throw new Error(`asked for For you offset ${offset}`);
    const slice = posts.slice(offset, offset + 25);
    const next = offset + 25 < posts.length ? { to: String(offset + 25), source: "list-1", limit: 25, page: offset / 25 + 1 } : null;
    return {
      data: {
        webRecommendedFeed: {
          items: slice.map((post, i) => ({ reasonString: reason(offset + i), post })),
          pagingInfo: { next },
        },
      },
    };
  };
}
