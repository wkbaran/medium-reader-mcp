import { describe, expect, it } from "vitest";
import { MediumClient, parseAccountRef, parsePostId } from "../src/medium/api.js";
import { AuthError, MediumHttp } from "../src/medium/http.js";
import { asViewer, fakeMedium, rawPost, SESSION, VIEWER, type GqlRequest } from "./helpers.js";

function client(handlers: Parameters<typeof fakeMedium>[0], session: typeof SESSION | null = SESSION) {
  const fake = fakeMedium({ Viewer: asViewer(VIEWER), ...handlers });
  const http = new MediumHttp({ session: session ?? undefined, fetch: fake.fetch, sleep: async () => undefined });
  return { client: new MediumClient(http), requests: fake.requests };
}

describe("parsePostId", () => {
  it.each([
    ["a64152b37c35", "a64152b37c35"],
    ["https://medium.com/@karpathy/software-2-0-a64152b37c35", "a64152b37c35"],
    ["https://karpathy.medium.com/software-2-0-a64152b37c35?source=rss", "a64152b37c35"],
    ["https://pub.towardsai.net/silent-schema-drift-b7ea04132470", "b7ea04132470"],
    ["medium.com/p/b7ea04132470", "b7ea04132470"],
    ["https://medium.com/m/global-identity-2?redirectUrl=https%3A%2F%2Fblog.example.com%2Fpost-title-3f2a1b0c9d8e", "3f2a1b0c9d8e"],
    ["https://medium.com/better-programming/some-post-5a14a3a3ebf6/", "5a14a3a3ebf6"],
  ])("%s", (input, id) => {
    expect(parsePostId(input)).toBe(id);
  });

  it("rejects things without an id", () => {
    expect(() => parsePostId("https://medium.com/@karpathy")).toThrow(/post id/);
    expect(() => parsePostId("hello world")).toThrow();
  });
});

describe("parseAccountRef", () => {
  it("recognises users, publications, and custom domains", () => {
    expect(parseAccountRef("@karpathy")).toEqual({ username: "karpathy" });
    expect(parseAccountRef("https://medium.com/@karpathy/")).toEqual({ username: "karpathy", explicit: true });
    expect(parseAccountRef("https://medium.com/javarevisited")).toEqual({ slug: "javarevisited", explicit: true });
    expect(parseAccountRef("dataexpert.medium.com")).toEqual({ username: "dataexpert", slug: "dataexpert", explicit: true });
    expect(parseAccountRef("https://pub.towardsai.net")).toEqual({ slug: "pub.towardsai.net", explicit: true });
    expect(parseAccountRef("javarevisited")).toEqual({ slug: "javarevisited" });
    expect(parseAccountRef("Towards AI")).toEqual({});
  });
});

describe("recentPosts", () => {
  it("starts past pinned posts", async () => {
    const { client: c, requests } = client({
      User: { data: { userResult: { __typename: "User", id: "k1", name: "Kay", username: "kay" } } },
      UserPosts: { data: { userResult: { homepagePostsConnection: { posts: [rawPost("aaaaaaaaaaaa")], pagingInfo: { next: { from: "L1", limit: 1 } } } } } },
    });
    const before = Date.now();
    const r = await c.recentPosts("@kay", { limit: 1 });
    const from = (requests.find((q) => q.operationName === "UserPosts")!.variables.paging as { from: string }).from;
    expect(from).toMatch(/^L\d+$/);
    expect(Number(from.slice(1))).toBeGreaterThanOrEqual(before);
    expect(r.nextCursor).toBeTruthy();
  });
});

describe("whoami", () => {
  it("treats a logged-out viewer as an expired session", async () => {
    // What Medium does when only `sid` is sent, or the cookies are stale.
    const { client: c } = client({}, { sid: "1:stale", uid: "nope" });
    const err = await c.whoami().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).reason).toBe("expired");
  });

  it("reports membership", async () => {
    const { client: c } = client({});
    expect(await c.whoami()).toEqual({ id: SESSION.uid, name: "Test User", username: "tester", membership: "MEMBER" });
  });
});

describe("feed", () => {
  const page = (ids: string[], next: Record<string, unknown> | null) => ({
    data: {
      followingFeed: {
        items: ids.map((id, n) => ({
          reason: 1,
          postProviderExplanation: { reason: "PUBLISHED_BY_COLLECTION" },
          post: rawPost(id, { firstPublishedAt: Date.UTC(2026, 8, 25) - Number(id.slice(1)) * 86_400_000 - n }),
        })),
        pagingInfo: { next },
      },
    },
  });

  it("pages through Medium's cursor until the limit and returns a resumable cursor", async () => {
    const { client: c, requests } = client({
      FollowingFeed: (req: GqlRequest) => {
        const paging = req.variables.paging as { to?: string };
        return paging.to ? page(["p3", "p4"], { to: "4", from: "2", limit: 2, source: "" }) : page(["p1", "p2"], { to: "2", from: "0", limit: 2, source: "" });
      },
    });
    const first = await c.feed({ limit: 3 });
    expect(first.items.map((i) => i.id)).toEqual(["p1", "p2", "p3"]);
    expect(first.items[0]).toMatchObject({ reason: "PUBLISHED_BY_COLLECTION", memberOnly: false, readingMinutes: 4 });
    expect(first.nextCursor).toBeTruthy();
    // Empty `source` strings are dropped: Medium rejects them.
    expect(requests.filter((r) => r.operationName === "FollowingFeed").at(-1)!.variables.paging).toEqual({ to: "2", from: "0", limit: 1 });
  });

  it("stops at `since`", async () => {
    const { client: c } = client({ FollowingFeed: page(["p1", "p2", "p9"], { to: "3", limit: 3 }) });
    const r = await c.feed({ limit: 10, since: new Date(Date.UTC(2026, 8, 22)) });
    expect(r.items.map((i) => i.id)).toEqual(["p1", "p2"]);
  });

  it("needs a login", async () => {
    const { client: c } = client({}, null);
    await expect(c.feed()).rejects.toBeInstanceOf(AuthError);
  });
});

describe("following", () => {
  const users = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: `u${from + i}`, name: `U${from + i}`, username: `u${from + i}` }));

  it("pages in chunks of 25 (Medium's maximum) to fill a larger limit", async () => {
    const { client: c, requests } = client({
      FollowCounts: { data: { userResult: { socialStats: { followingCount: 945 } } } },
      FollowingUsers: (req: GqlRequest) => {
        const paging = req.variables.paging as { from?: string; limit: number };
        if (paging.limit > 25) return { errors: [{ message: 'Invalid value. Expected maximum "25".' }] };
        const start = Number(paging.from ?? 0);
        const n = Math.min(paging.limit, 60 - start);
        return { data: { userResult: { followingUserConnection: { users: users(start, n), pagingInfo: { next: start + n < 60 ? { from: String(start + n), limit: 25 } : null } } } } };
      },
    });
    const first = await c.following({ limit: 40 });
    expect(first.items.map((u) => u.id)).toEqual(users(0, 40).map((u) => u.id));
    expect(first.total).toBe(945);
    expect(requests.filter((r) => r.operationName === "FollowingUsers").map((r) => (r.variables.paging as { limit: number }).limit)).toEqual([25, 15]);
    const rest = await c.following({ limit: 40, cursor: first.nextCursor });
    expect(rest.items.map((u) => u.id)).toEqual(users(40, 20).map((u) => u.id));
    expect(rest.nextCursor).toBeUndefined();
  });
});

describe("readingHistory", () => {
  const page = (ids: Array<string | null>, to: string | null) => ({
    data: {
      viewer: {
        id: SESSION.uid,
        readingHistory: {
          postPreviewConnection: {
            postPreviews: ids.map((id, n) => ({ postId: id ?? `gone${n}`, post: id ? rawPost(id) : null })),
            pagingInfo: { next: to ? { to, limit: 15, page: null } : null },
          },
        },
      },
    },
  });

  it("follows Medium's `to` cursor, skips deleted posts, and resumes", async () => {
    const { client: c, requests } = client({
      ReadingHistory: (req: GqlRequest) => {
        const paging = req.variables.paging as { to?: string };
        if (!paging.to) return page(["a1", null, "a2"], "200");
        if (paging.to === "200") return page([null], "150");
        if (paging.to === "150") return page(["a3", "a4"], "100");
        return page([], null);
      },
    });
    const first = await c.readingHistory({ limit: 3 });
    expect(first.items.map((p) => p.id)).toEqual(["a1", "a2", "a3", "a4"]);
    expect(requests.filter((r) => r.operationName === "ReadingHistory").map((r) => r.variables.paging)).toEqual([{ limit: 15 }, { to: "200", limit: 15 }, { to: "150", limit: 15 }]);
    const rest = await c.readingHistory({ cursor: first.nextCursor });
    expect(rest.items).toEqual([]);
    expect(rest.nextCursor).toBeUndefined();
  });

  it("needs a login", async () => {
    const { client: c } = client({}, null);
    await expect(c.readingHistory()).rejects.toBeInstanceOf(AuthError);
  });
});

describe("post", () => {
  const body = { bodyModel: { paragraphs: [{ type: "P", text: "Hello", markups: [] }] } };

  it("returns full content and the preview flag", async () => {
    const { client: c, requests } = client({
      Post: {
        data: {
          post: { ...rawPost("b7ea04132470", { isLocked: true }), wordCount: 900, tags: [{ id: "ai", displayTitle: "AI" }], viewerEdge: { id: "e", fullContent: { isLockedPreviewOnly: false, ...body } } },
        },
      },
    });
    const post = await c.post("https://pub.towardsai.net/x-b7ea04132470");
    expect(requests.find((r) => r.operationName === "Post")!.variables).toEqual({ id: "b7ea04132470" });
    expect(post).toMatchObject({ previewOnly: false, wordCount: 900, tags: ["AI"], summary: { memberOnly: true } });
    expect(post.paragraphs).toHaveLength(1);
  });

  it("flags previews", async () => {
    const { client: c } = client({
      Post: { data: { post: { ...rawPost("abcdef012345", { isLocked: true }), viewerEdge: { fullContent: { isLockedPreviewOnly: true, ...body } } } } },
    });
    expect((await c.post("abcdef012345")).previewOnly).toBe(true);
  });

  it("reports a missing post", async () => {
    const { client: c } = client({ Post: { data: { post: null } } });
    await expect(c.post("abcdef012345")).rejects.toThrow(/No Medium post/);
  });
});

describe("account changes", () => {
  const state = (clapCount: number, lists: { reading?: boolean } = {}) => ({
    data: {
      post: {
        id: "abcdef012345",
        title: "T",
        clapCount: 100 + clapCount,
        viewerEdge: {
          id: "e",
          clapCount,
          catalogsConnection: {
            catalogsContainingThis: [],
            predefinedContainingThis: lists.reading ? [{ catalogId: "predefined:u:READING_LIST", predefined: "READING_LIST", version: "v1", catalogItemIds: ["item1"] }] : [],
          },
        },
      },
    },
  });

  it("refuses to clap past Medium's limit", async () => {
    const { client: c, requests } = client({ PostViewerState: state(48) });
    await expect(c.clap("abcdef012345", 5)).rejects.toThrow(/At most 2 more/);
    expect(requests.some((r) => r.operationName === "Clap")).toBe(false);
  });

  it("undoes claps with a negative count", async () => {
    let mine = 3;
    const { client: c, requests } = client({
      PostViewerState: () => state(mine),
      Clap: (req) => {
        mine += req.variables.numClaps as number;
        return { data: { clap: { id: "abcdef012345" } } };
      },
    });
    expect(await c.clap("abcdef012345", 0)).toMatchObject({ changed: true, yourClaps: 0 });
    expect(requests.find((r) => r.operationName === "Clap")!.variables).toEqual({ postId: "abcdef012345", userId: SESSION.uid, numClaps: -3 });
  });

  it("doesn't call the mutation when already following", async () => {
    const { client: c, requests } = client({
      User: { data: { userResult: { __typename: "User", id: "k1", name: "Kay", username: "kay", viewerEdge: { isFollowing: true } } } },
    });
    expect(await c.follow("@kay", true)).toMatchObject({ changed: false, following: true });
    expect(requests.some((r) => r.operationName === "FollowUser")).toBe(false);
  });

  it("verifies a follow by re-reading", async () => {
    let following = false;
    const { client: c } = client({
      User: () => ({ data: { userResult: { __typename: "User", id: "k1", name: "Kay", username: "kay", viewerEdge: { isFollowing: following } } } }),
      FollowUser: () => {
        following = true;
        return { data: { followUser: { id: "k1" } } };
      },
    });
    expect(await c.follow("@kay", true)).toMatchObject({ changed: true, following: true, message: "Now following Kay." });
  });

  it("mutes and unmutes, verified by re-reading", async () => {
    let muting = false;
    const { client: c, requests } = client({
      User: () => ({ data: { userResult: { __typename: "User", id: "k1", name: "Kay", username: "kay", viewerEdge: { isFollowing: false, isMuting: muting } } } }),
      MuteUser: () => {
        muting = true;
        return { data: { muteUser: { __typename: "User" } } };
      },
      UnmuteUser: () => {
        muting = false;
        return { data: { unmuteUser: { __typename: "User" } } };
      },
    });
    const muted = await c.mute("@kay", true);
    expect(muted).toMatchObject({ changed: true, muted: true, message: "Muted Kay." });
    expect(muted.account).not.toHaveProperty("isMuting");
    expect(await c.mute("@kay", true)).toMatchObject({ changed: false, muted: true });
    expect(requests.filter((r) => r.operationName === "MuteUser")).toHaveLength(1);
    expect(await c.mute("@kay", false)).toMatchObject({ changed: true, muted: false, message: "Unmuted Kay." });
  });

  it("mutes a publication with the collection mutation", async () => {
    let muting = false;
    const { client: c, requests } = client({
      Publication: () => ({ data: { collectionByDomainOrSlug: { id: "c1", name: "Java Revisited", slug: "javarevisited", viewerEdge: { isFollowing: true, isMuting: muting } } } }),
      MuteCollection: () => {
        muting = true;
        return { data: { muteCollection: { __typename: "Collection" } } };
      },
    });
    // By URL, and with a slug that isn't the display name: the re-read must not
    // treat it as an ambiguous bare word.
    expect(await c.mute("https://medium.com/javarevisited", true)).toMatchObject({ changed: true, muted: true });
    expect(requests.find((r) => r.operationName === "MuteCollection")!.variables).toEqual({ id: "c1" });
  });

  it("lists candidates instead of guessing an ambiguous name", async () => {
    const { client: c } = client({
      Publication: { data: { collectionByDomainOrSlug: null } },
      User: { data: { userResult: null } },
      SearchAccounts: {
        data: {
          search: {
            people: { items: [{ id: "u1", name: "Sam Lee", username: "samlee" }] },
            collections: { items: [{ id: "c1", name: "Sam's Notes", slug: "sams-notes" }] },
          },
        },
      },
    });
    const err = await c.follow("sam", true).catch((e: unknown) => e as Error);
    expect(err.message).toMatch(/ambiguous/);
    expect(err.message).toContain("@samlee");
    expect(err.message).toContain("sams-notes");
  });

  it("doesn't follow a slug match whose name differs from what was asked", async () => {
    const { client: c, requests } = client({
      Publication: { data: { collectionByDomainOrSlug: { id: "c9", name: "Sam blog :]", slug: "sam", viewerEdge: { isFollowing: false } } } },
      User: { data: { userResult: null } },
      SearchAccounts: { data: { search: { people: { items: [{ id: "u1", name: "Sam Lee", username: "samlee" }] }, collections: { items: [] } } } },
    });
    const err = await c.follow("sam", true).catch((e: unknown) => e as Error);
    expect(err.message).toMatch(/ambiguous/);
    expect(err.message).toContain("Sam blog :]");
    expect(err.message).toContain("@samlee");
    expect(requests.some((r) => r.operationName === "FollowCollection")).toBe(false);
    // Reads still take the convenient shortcut.
    expect((await c.resolveAccount("sam")).name).toBe("Sam blog :]");
  });

  it("follows a bare slug when the name matches", async () => {
    let following = false;
    const { client: c } = client({
      Publication: () => ({ data: { collectionByDomainOrSlug: { id: "c1", name: "Javarevisited", slug: "javarevisited", viewerEdge: { isFollowing: following } } } }),
      FollowCollection: () => {
        following = true;
        return { data: { followCollection: { id: "c1" } } };
      },
    });
    expect(await c.follow("javarevisited", true)).toMatchObject({ changed: true, following: true });
  });

  it("removes every copy of a post from the reading list", async () => {
    let inList = true;
    const { client: c, requests } = client({
      PostViewerState: () => state(0, { reading: inList }),
      EditCatalogItems: () => {
        inList = false;
        return { data: { editCatalogItems: { __typename: "EditCatalogItemsSuccess", version: "v2" } } };
      },
    });
    expect(await c.removeFromList("abcdef012345")).toMatchObject({ changed: true, message: "Removed from Reading list." });
    expect(requests.find((r) => r.operationName === "EditCatalogItems")!.variables).toEqual({
      catalogId: "predefined:u:READING_LIST",
      version: "v1",
      operations: [{ delete: { itemId: "item1" } }],
    });
  });

  it("saves to the reading list with Medium's (misspelled) preprend operation", async () => {
    let inList = false;
    const { client: c, requests } = client({
      PostViewerState: () => state(0, { reading: inList }),
      AddToReadingList: () => {
        inList = true;
        return { data: { addToPredefinedCatalog: { __typename: "AddToPredefinedCatalogSucces", version: "v2" } } };
      },
    });
    expect(await c.saveToList("abcdef012345")).toMatchObject({ changed: true });
    expect(requests.find((r) => r.operationName === "AddToReadingList")!.variables).toEqual({ operation: { preprend: { type: "POST", id: "abcdef012345" } } });
  });
});
