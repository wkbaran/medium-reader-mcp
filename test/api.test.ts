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
