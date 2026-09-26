import type { MediumUser } from "../auth/credentials.js";
import type { Paragraph } from "../format.js";
import { AuthError, MediumError, MediumHttp } from "./http.js";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

interface RawPost {
  id: string;
  title?: string | null;
  mediumUrl?: string | null;
  isLocked?: boolean | null;
  firstPublishedAt?: number | null;
  latestPublishedAt?: number | null;
  readingTime?: number | null;
  wordCount?: number | null;
  clapCount?: number | null;
  creator?: { id: string; name?: string | null; username?: string | null } | null;
  collection?: { id: string; name?: string | null; slug?: string | null } | null;
  extendedPreviewContent?: { subtitle?: string | null } | null;
  tags?: Array<{ id: string; displayTitle?: string | null }> | null;
}

export interface PostSummary {
  id: string;
  title: string;
  subtitle?: string;
  author?: string;
  authorUsername?: string;
  publication?: string;
  url?: string;
  published?: string;
  readingMinutes?: number;
  claps?: number;
  /** Medium's "Member-only story" flag. Describes the post, not whether you can read it. */
  memberOnly: boolean;
  /** Why the feed showed it ("Because you follow History", "PUBLISHED_BY_COLLECTION", ...). */
  reason?: string;
}

export interface FullPost {
  summary: PostSummary;
  tags: string[];
  wordCount?: number;
  paragraphs: Paragraph[];
  /** Medium served a truncated preview because the viewer isn't a member (or isn't logged in). */
  previewOnly: boolean;
}

export interface Page<T> {
  items: T[];
  /** Pass back as `cursor` to get the next page; absent when there are no more. */
  nextCursor?: string;
}

export interface Account {
  kind: "user" | "publication";
  id: string;
  name?: string;
  username?: string;
  slug?: string;
  url: string;
  description?: string;
}

export interface ListInfo {
  id: string;
  name: string;
  count?: number;
  visibility?: string;
  version?: string;
}

export type FeedSource = "following" | "for_you";

// ---------------------------------------------------------------------------
// Queries. Hand-written subsets of what medium.com's own web app sends; the
// originals can be recovered from its JS bundles (see CLAUDE.md).
// ---------------------------------------------------------------------------

const POST_FIELDS = `
  id title mediumUrl isLocked firstPublishedAt latestPublishedAt readingTime clapCount
  creator { id name username }
  collection { id name slug }
  extendedPreviewContent { subtitle }`;

const PARAGRAPH_FIELDS = `
  paragraphs {
    name type text href
    metadata { id alt }
    mixtapeMetadata { href }
    iframe { mediaResource { href iframeSrc title } }
    codeBlockMetadata { lang mode }
    markups { type start end href anchorType userId }
  }`;

const Q = {
  viewer: `query Viewer { viewer { id name username membership { tier } } }`,

  followingFeed: `query FollowingFeed($paging: PagingOptions) {
    followingFeed(paging: $paging) {
      items { reason postProviderExplanation { reason } post { ${POST_FIELDS} } }
      pagingInfo { next { to from limit source } }
    }
  }`,

  recommendedFeed: `query RecommendedFeed($paging: PagingOptions) {
    webRecommendedFeed(paging: $paging) {
      items { reasonString post { ${POST_FIELDS} } }
      pagingInfo { next { to from limit source } }
    }
  }`,

  post: `query Post($id: ID!) {
    post(id: $id) {
      ${POST_FIELDS}
      wordCount
      tags { id displayTitle }
      viewerEdge { id fullContent { isLockedPreviewOnly bodyModel { ${PARAGRAPH_FIELDS} } } }
    }
  }`,

  userPosts: `query UserPosts($username: ID, $id: ID, $paging: PagingOptions) {
    userResult(username: $username, id: $id) {
      __typename
      ... on User {
        id
        homepagePostsConnection(paging: $paging, includeDistributedResponses: false) {
          posts { ${POST_FIELDS} }
          pagingInfo { next { from limit } }
        }
      }
    }
  }`,

  publicationPosts: `query PublicationPosts($slug: ID!, $paging: PagingOptions) {
    collectionByDomainOrSlug(domainOrSlug: $slug) {
      id
      homepagePostsConnection(paging: $paging) {
        posts { ${POST_FIELDS} }
        pagingInfo { next { from limit } }
      }
    }
  }`,

  user: `query User($username: ID, $id: ID) {
    userResult(username: $username, id: $id) {
      __typename
      ... on User { id name username bio viewerEdge { id isFollowing isMuting } }
    }
  }`,

  publication: `query Publication($slug: ID!) {
    collectionByDomainOrSlug(domainOrSlug: $slug) {
      id name slug domain description viewerEdge { id isFollowing isMuting }
    }
  }`,

  followingUsers: `query FollowingUsers($id: ID, $paging: PagingOptions) {
    userResult(id: $id) {
      ... on User {
        followingUserConnection(paging: $paging) {
          users { id name username bio }
          pagingInfo { next { from limit } }
        }
      }
    }
  }`,

  followingPublications: `query FollowingPublications($id: ID) {
    userResult(id: $id) {
      ... on User { followingCollectionConnection { collections { id name slug domain description } } }
    }
  }`,

  readingHistory: `query ReadingHistory($paging: PagingOptions) {
    viewer {
      id
      readingHistory {
        postPreviewConnection(paging: $paging) {
          postPreviews { postId post { ${POST_FIELDS} } }
          pagingInfo { next { to limit page } }
        }
      }
    }
  }`,

  followCounts: `query FollowCounts($id: ID) {
    userResult(id: $id) { ... on User { socialStats { followingCount collectionFollowingCount } } }
  }`,

  search: `query Search($query: String!, $paging: SearchPagingOptions!) {
    search(query: $query) {
      ... on Search {
        posts(pagingOptions: $paging) {
          ... on SearchPost { items { ${POST_FIELDS} } pagingInfo { next { limit page } } }
        }
      }
    }
  }`,

  searchAccounts: `query SearchAccounts($query: String!, $paging: SearchPagingOptions!) {
    search(query: $query) {
      ... on Search {
        people(pagingOptions: $paging) {
          ... on SearchPeople { items { ... on User { id name username bio } } }
        }
        collections(pagingOptions: $paging) {
          ... on SearchCollection { items { id name slug domain description } }
        }
      }
    }
  }`,

  readingList: `query ReadingList($id: ID!) {
    getPredefinedCatalog(userId: $id, type: READING_LIST) {
      ... on Catalog { id name version itemsConnection(pagingOptions: { limit: 1 }) { paging { count } } }
    }
  }`,

  lists: `query Lists($id: ID!, $paging: CatalogPagingOptionsInput!) {
    catalogsByUser(userId: $id, pagingOptions: $paging, type: LISTS) {
      ... on CatalogsConnection {
        catalogs { id name visibility version itemsConnection(pagingOptions: { limit: 1 }) { paging { count } } }
        paging { nextPageCursor { id } }
      }
    }
  }`,

  readingListItems: `query ReadingListItems($id: ID!, $paging: CatalogPagingOptionsInput!) {
    getPredefinedCatalog(userId: $id, type: READING_LIST) {
      ... on Catalog {
        id name
        itemsConnection(pagingOptions: $paging) {
          items { catalogItemId entity { __typename ... on Post { ${POST_FIELDS} } } }
          paging { count nextPageCursor { id } }
        }
      }
    }
  }`,

  listItems: `query ListItems($id: ID!, $paging: CatalogPagingOptionsInput!) {
    catalogById(catalogId: $id) {
      ... on Catalog {
        id name
        itemsConnection(pagingOptions: $paging) {
          items { catalogItemId entity { __typename ... on Post { ${POST_FIELDS} } } }
          paging { count nextPageCursor { id } }
        }
      }
    }
  }`,

  postViewerState: `query PostViewerState($id: ID!) {
    post(id: $id) {
      id title clapCount
      viewerEdge {
        id clapCount
        catalogsConnection {
          catalogsContainingThis(type: LISTS) { catalogId version catalogItemIds }
          predefinedContainingThis { catalogId predefined version catalogItemIds }
        }
      }
    }
  }`,

  followUser: `mutation FollowUser($id: ID!) { followUser(targetUserId: $id) { id name viewerEdge { id isFollowing } } }`,
  unfollowUser: `mutation UnfollowUser($id: ID!) { unfollowUser(targetUserId: $id) { id name viewerEdge { id isFollowing } } }`,
  followCollection: `mutation FollowCollection($id: ID!) { followCollection(targetCollectionId: $id) { id name viewerEdge { id isFollowing } } }`,
  muteUser: `mutation MuteUser($id: ID!) { muteUser(targetUserId: $id) { __typename } }`,
  unmuteUser: `mutation UnmuteUser($id: ID!) { unmuteUser(targetUserId: $id) { __typename } }`,
  muteCollection: `mutation MuteCollection($id: ID!) { muteCollection(targetCollectionId: $id) { __typename } }`,
  unmuteCollection: `mutation UnmuteCollection($id: ID!) { unmuteCollection(targetCollectionId: $id) { __typename } }`,
  unfollowCollection: `mutation UnfollowCollection($id: ID!) { unfollowCollection(targetCollectionId: $id) { id name viewerEdge { id isFollowing } } }`,

  clap: `mutation Clap($postId: ID!, $userId: ID!, $numClaps: Int!) {
    clap(targetPostId: $postId, userId: $userId, numClaps: $numClaps) { id clapCount viewerEdge { id clapCount } }
  }`,

  addToReadingList: `mutation AddToReadingList($operation: PredefinedCatalogAddOperationInput!) {
    addToPredefinedCatalog(type: READING_LIST, operation: $operation) {
      __typename
      ... on AddToPredefinedCatalogSucces { version }
    }
  }`,

  editCatalogItems: `mutation EditCatalogItems($catalogId: String!, $version: String!, $operations: [CatalogItemMutateOperationInput!]!) {
    editCatalogItems(catalogId: $catalogId, version: $version, operations: $operations) {
      __typename
      ... on EditCatalogItemsSuccess { version }
    }
  }`,
};

/** Medium allows at most this many claps per reader per post. */
export const MAX_CLAPS = 50;
export const READING_LIST = "reading-list";

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class MediumClient {
  private viewerCache: { at: number; user: MediumUser } | null = null;

  constructor(readonly http: MediumHttp) {}

  get authenticated(): boolean {
    return this.http.authenticated;
  }

  /** The logged-in account. Throws AuthError when there's no valid session. */
  async whoami(): Promise<MediumUser> {
    if (this.viewerCache && Date.now() - this.viewerCache.at < 10 * 60_000) return this.viewerCache.user;
    const data = await this.http.gql<{ viewer: { id: string; name?: string; username?: string; membership?: { tier?: string } | null } | null }>(
      Q.viewer,
      {},
      { requireAuth: true },
    );
    // A cookie Medium doesn't accept (or `sid` without `uid`) is served as a logged-out viewer.
    if (!data.viewer) throw new AuthError("expired");
    const v = data.viewer;
    const user = { id: v.id, name: v.name, username: v.username, membership: v.membership?.tier ?? null };
    this.viewerCache = { at: Date.now(), user };
    return user;
  }

  // ---- reading ----

  async feed(opts: { source?: FeedSource; limit?: number; since?: Date; cursor?: string } = {}): Promise<Page<PostSummary>> {
    const source = opts.source ?? "following";
    const limit = opts.limit ?? 25;
    await this.whoami(); // both feeds are empty for logged-out visitors; say so instead
    // The cursor carries `since` (as `_since`), so a caller that pages with the
    // cursor but forgets `since` still stops at the same point.
    const { _since, ...resumed } = decodeCursor<Record<string, unknown>>(opts.cursor) ?? {};
    const since = opts.since ?? (typeof _since === "number" ? new Date(_since) : undefined);
    let paging: Record<string, unknown> = opts.cursor ? resumed : { limit: Math.min(limit, 25) };
    const items: PostSummary[] = [];
    const seen = new Set<string>();

    for (let round = 0; round < 10 && items.length < limit; round++) {
      const page = source === "following" ? await this.followingPage(paging) : await this.recommendedPage(paging);
      let fresh = 0;
      for (const post of page.items) {
        if (seen.has(post.id)) continue;
        seen.add(post.id);
        if (since && post.published && Date.parse(post.published) < since.getTime()) continue;
        fresh++;
        if (items.length < limit) items.push(post);
      }
      if (!page.next) return { items };
      paging = { ...page.next, limit: Math.min(limit - items.length || limit, 25) };
      // The feed is roughly newest-first; a page with nothing new enough means we're done.
      if (since && fresh === 0) return { items };
    }
    return { items, nextCursor: encodeCursor(since ? { ...paging, _since: since.getTime() } : paging) };
  }

  private async followingPage(paging: Record<string, unknown>) {
    type Item = { reason?: number; postProviderExplanation?: { reason?: string } | null; post?: RawPost | null };
    const data = await this.http.gql<{ followingFeed: { items: Item[]; pagingInfo?: { next?: Record<string, unknown> | null } | null } | null }>(
      Q.followingFeed,
      { paging: cleanPaging(paging) },
      { requireAuth: true },
    );
    const feed = data.followingFeed;
    return {
      items: (feed?.items ?? []).flatMap((i) => (i.post ? [{ ...summarize(i.post), reason: i.postProviderExplanation?.reason ?? undefined }] : [])),
      next: feed?.pagingInfo?.next ?? null,
    };
  }

  private async recommendedPage(paging: Record<string, unknown>) {
    type Item = { reasonString?: string | null; post?: RawPost | null };
    const data = await this.http.gql<{ webRecommendedFeed: { items: Item[]; pagingInfo?: { next?: Record<string, unknown> | null } | null } | null }>(
      Q.recommendedFeed,
      { paging: cleanPaging(paging) },
      { requireAuth: true },
    );
    const feed = data.webRecommendedFeed;
    return {
      items: (feed?.items ?? []).flatMap((i) => (i.post ? [{ ...summarize(i.post), reason: i.reasonString ?? undefined }] : [])),
      next: feed?.pagingInfo?.next ?? null,
    };
  }

  async post(ref: string): Promise<FullPost> {
    const id = parsePostId(ref);
    const data = await this.http.gql<{
      post: (RawPost & { viewerEdge?: { fullContent?: { isLockedPreviewOnly?: boolean; bodyModel?: { paragraphs?: Paragraph[] } } | null } | null }) | null;
    }>(Q.post, { id });
    const post = data.post;
    if (!post) throw new MediumError(`No Medium post found for ${ref}.`, 404);
    const content = post.viewerEdge?.fullContent;
    return {
      summary: summarize(post),
      tags: (post.tags ?? []).map((t) => t.displayTitle || t.id),
      wordCount: post.wordCount ?? undefined,
      paragraphs: content?.bodyModel?.paragraphs ?? [],
      previewOnly: Boolean(content?.isLockedPreviewOnly),
    };
  }

  /** Latest posts from an author or a publication. */
  async recentPosts(ref: string, opts: { limit?: number; cursor?: string } = {}): Promise<Page<PostSummary> & { source: Account }> {
    const account = await this.resolveAccount(ref);
    // homepagePostsConnection lists pinned posts first ("P…" cursors), then the
    // rest newest first ("L<timestamp>" cursors). Starting at L<now> skips the pins.
    const paging = decodeCursor<Record<string, unknown>>(opts.cursor) ?? { from: `L${Date.now()}` };
    const vars = { paging: cleanPaging({ ...paging, limit: opts.limit ?? 10 }) };
    type Conn = { posts: RawPost[]; pagingInfo?: { next?: Record<string, unknown> | null } | null } | null;
    let conn: Conn;
    if (account.kind === "user") {
      const data = await this.http.gql<{ userResult: { homepagePostsConnection?: Conn } | null }>(Q.userPosts, { id: account.id, ...vars });
      conn = data.userResult?.homepagePostsConnection ?? null;
    } else {
      const data = await this.http.gql<{ collectionByDomainOrSlug: { homepagePostsConnection?: Conn } | null }>(Q.publicationPosts, {
        slug: account.slug ?? account.id,
        ...vars,
      });
      conn = data.collectionByDomainOrSlug?.homepagePostsConnection ?? null;
    }
    const next = conn?.pagingInfo?.next;
    return {
      source: account,
      items: (conn?.posts ?? []).map(summarize),
      nextCursor: next?.from ? encodeCursor(next) : undefined,
    };
  }

  async search(query: string, opts: { limit?: number; page?: number } = {}): Promise<Page<PostSummary>> {
    const limit = opts.limit ?? 10;
    const page = opts.page ?? 0;
    const data = await this.http.gql<{ search: { posts?: { items?: RawPost[]; pagingInfo?: { next?: { page?: number } | null } | null } | null } | null }>(
      Q.search,
      { query, paging: { limit, page } },
    );
    const posts = data.search?.posts;
    const nextPage = posts?.pagingInfo?.next?.page;
    return { items: (posts?.items ?? []).map(summarize), nextCursor: nextPage != null ? String(nextPage) : undefined };
  }

  async following(opts: { kind?: "users" | "publications"; limit?: number; cursor?: string } = {}) {
    const me = await this.whoami();
    const kind = opts.kind ?? "users";
    const counts = await this.http
      .gql<{ userResult: { socialStats?: { followingCount?: number; collectionFollowingCount?: number } } | null }>(Q.followCounts, { id: me.id })
      .then((d) => d.userResult?.socialStats ?? {})
      .catch(() => ({}) as { followingCount?: number; collectionFollowingCount?: number });

    if (kind === "publications") {
      // Medium returns the whole list in one go; page it locally.
      type Coll = { id: string; name?: string; slug?: string; domain?: string | null; description?: string | null };
      const data = await this.http.gql<{ userResult: { followingCollectionConnection?: { collections: Coll[] } } | null }>(
        Q.followingPublications,
        { id: me.id },
        { requireAuth: true },
      );
      const all = (data.userResult?.followingCollectionConnection?.collections ?? []).map(publicationAccount);
      const offset = Number(opts.cursor ?? 0) || 0;
      const limit = opts.limit ?? 50;
      const items = all.slice(offset, offset + limit);
      return {
        total: counts.collectionFollowingCount ?? all.length,
        items,
        nextCursor: offset + limit < all.length ? String(offset + limit) : undefined,
      };
    }

    // Medium caps followingUserConnection pages at 25, so fetch several to fill `limit`.
    type U = { id: string; name?: string; username?: string; bio?: string | null };
    const limit = opts.limit ?? 50;
    let paging: Record<string, unknown> | null = decodeCursor<Record<string, unknown>>(opts.cursor) ?? {};
    const items: Account[] = [];
    while (paging && items.length < limit) {
      const data: { userResult: { followingUserConnection?: { users: U[]; pagingInfo?: { next?: Record<string, unknown> | null } | null } } | null } =
        await this.http.gql(Q.followingUsers, { id: me.id, paging: cleanPaging({ ...paging, limit: Math.min(limit - items.length, FOLLOWING_PAGE) }) }, { requireAuth: true });
      const conn = data.userResult?.followingUserConnection;
      items.push(...(conn?.users ?? []).map(userAccount));
      const next = conn?.pagingInfo?.next;
      paging = next?.from && conn?.users.length ? next : null;
    }
    return {
      // socialStats counts more accounts than the list returns (945 vs 802 on a test account).
      total: counts.followingCount,
      items,
      nextCursor: paging ? encodeCursor(paging) : undefined,
    };
  }

  /**
   * Posts the user has read, most recently read first. Medium pages this 15 at a
   * time by a `to` timestamp and gives no per-post read time.
   */
  async readingHistory(opts: { limit?: number; cursor?: string } = {}): Promise<Page<PostSummary>> {
    const limit = opts.limit ?? 25;
    type Conn = { postPreviews?: Array<{ postId?: string; post?: RawPost | null }>; pagingInfo?: { next?: Record<string, unknown> | null } | null };
    let paging: Record<string, unknown> | null = decodeCursor<Record<string, unknown>>(opts.cursor) ?? { limit: HISTORY_PAGE };
    const items: PostSummary[] = [];
    const seen = new Set<string>();
    while (paging && items.length < limit) {
      const data: { viewer: { readingHistory?: { postPreviewConnection?: Conn | null } | null } | null } = await this.http.gql(
        Q.readingHistory,
        { paging: cleanPaging(paging) },
        { requireAuth: true },
      );
      if (!data.viewer) throw new AuthError("expired");
      const conn = data.viewer.readingHistory?.postPreviewConnection;
      const previews = conn?.postPreviews ?? [];
      for (const p of previews) {
        // Deleted posts come back with a null `post`.
        if (!p.post || seen.has(p.post.id)) continue;
        seen.add(p.post.id);
        items.push(summarize(p.post));
      }
      const next = conn?.pagingInfo?.next;
      paging = next?.to && previews.length && next.to !== paging.to ? { to: next.to, page: next.page, limit: HISTORY_PAGE } : null;
    }
    // A page can overshoot `limit`; the cursor resumes after the whole page, so return all of it.
    return { items, nextCursor: paging ? encodeCursor(paging) : undefined };
  }

  async lists(): Promise<ListInfo[]> {
    const me = await this.whoami();
    type Cat = { id: string; name?: string; visibility?: string; version?: string; itemsConnection?: { paging?: { count?: number } } };
    const [rl, named] = await Promise.all([
      this.http.gql<{ getPredefinedCatalog: Cat | null }>(Q.readingList, { id: me.id }, { requireAuth: true }),
      this.allLists(me.id),
    ]);
    const out: ListInfo[] = [];
    if (rl.getPredefinedCatalog) {
      out.push({ id: READING_LIST, name: "Reading list", count: rl.getPredefinedCatalog.itemsConnection?.paging?.count, visibility: "PRIVATE" });
    }
    for (const c of named) {
      out.push({ id: c.id, name: c.name || "(untitled)", count: c.itemsConnection?.paging?.count, visibility: c.visibility, version: c.version });
    }
    return out;
  }

  private async allLists(userId: string) {
    type Cat = { id: string; name?: string; visibility?: string; version?: string; itemsConnection?: { paging?: { count?: number } } };
    const out: Cat[] = [];
    let cursor: { id: string } | undefined;
    for (let i = 0; i < 20; i++) {
      const data = await this.http.gql<{ catalogsByUser: { catalogs?: Cat[]; paging?: { nextPageCursor?: { id: string } | null } } | null }>(
        Q.lists,
        { id: userId, paging: cursor ? { limit: 25, cursor } : { limit: 25 } },
        { requireAuth: true },
      );
      out.push(...(data.catalogsByUser?.catalogs ?? []));
      cursor = data.catalogsByUser?.paging?.nextPageCursor ?? undefined;
      if (!cursor) break;
    }
    return out;
  }

  async listItems(listRef: string, opts: { limit?: number; cursor?: string } = {}) {
    const list = await this.resolveList(listRef);
    const paging = { limit: opts.limit ?? 25, ...(opts.cursor ? { cursor: { id: opts.cursor } } : {}) };
    type Items = { items: Array<{ entity?: (RawPost & { __typename?: string }) | null }>; paging?: { count?: number; nextPageCursor?: { id: string } | null } };
    let conn: Items | undefined;
    if (list.id === READING_LIST) {
      const me = await this.whoami();
      const data = await this.http.gql<{ getPredefinedCatalog: { itemsConnection?: Items } | null }>(Q.readingListItems, { id: me.id, paging }, { requireAuth: true });
      conn = data.getPredefinedCatalog?.itemsConnection;
    } else {
      const data = await this.http.gql<{ catalogById: { itemsConnection?: Items } | null }>(Q.listItems, { id: list.id, paging });
      conn = data.catalogById?.itemsConnection;
    }
    return {
      list: { id: list.id, name: list.name, count: conn?.paging?.count ?? list.count },
      // Deleted or unavailable posts come back as null entities.
      items: (conn?.items ?? []).flatMap((i) => (i.entity && i.entity.__typename === "Post" ? [summarize(i.entity)] : [])),
      nextCursor: conn?.paging?.nextPageCursor?.id,
    };
  }

  // ---- account changes ----

  async follow(ref: string, follow: boolean) {
    await this.whoami();
    const account = await this.resolveAccount(ref, { strict: true });
    const before = account.isFollowing;
    if (before === follow) {
      return { changed: false, following: follow, account: stripState(account), message: `Already ${follow ? "following" : "not following"} ${account.name ?? account.url}.` };
    }
    const mutation = account.kind === "user" ? (follow ? Q.followUser : Q.unfollowUser) : follow ? Q.followCollection : Q.unfollowCollection;
    await this.http.gql(mutation, { id: account.id }, { requireAuth: true, mutation: true });
    // Re-read rather than trusting the mutation's echo.
    const after = (await this.reread(account)).isFollowing;
    return {
      changed: after !== before,
      following: after,
      account: stripState(account),
      message:
        after === follow
          ? `${follow ? "Now following" : "Unfollowed"} ${account.name ?? account.url}.`
          : `Medium accepted the request but ${account.name ?? account.url} still shows as ${after ? "followed" : "not followed"}.`,
    };
  }

  /** Muting hides an author's or publication's posts from the user's feeds. It's private. */
  async mute(ref: string, mute: boolean) {
    await this.whoami();
    const account = await this.resolveAccount(ref, { strict: true });
    const label = account.name ?? account.url;
    const before = account.isMuting;
    if (before === mute) {
      return { changed: false, muted: mute, account: stripState(account), message: `${label} is already ${mute ? "muted" : "not muted"}.` };
    }
    const mutation = account.kind === "user" ? (mute ? Q.muteUser : Q.unmuteUser) : mute ? Q.muteCollection : Q.unmuteCollection;
    await this.http.gql(mutation, { id: account.id }, { requireAuth: true, mutation: true });
    // Re-read rather than trusting the mutation's echo.
    const after = (await this.reread(account)).isMuting;
    return {
      changed: after !== before,
      muted: after,
      account: stripState(account),
      message:
        after === mute
          ? `${mute ? "Muted" : "Unmuted"} ${label}.`
          : `Medium accepted the request but ${label} still shows as ${after ? "muted" : "not muted"}.`,
    };
  }

  /**
   * Look an account up again after a change. By URL, not slug: a bare slug is
   * name-checked in strict mode, and a publication's slug rarely matches its name.
   */
  private async reread(account: Account) {
    return this.resolveAccount(account.kind === "user" ? `@${account.username}` : account.url, { strict: true });
  }

  async clap(ref: string, count: number) {
    const me = await this.whoami();
    const id = parsePostId(ref);
    const state = await this.postViewerState(id);
    const mine = state.viewerEdge?.clapCount ?? 0;
    if (count > 0 && mine + count > MAX_CLAPS) {
      throw new MediumError(`You've already clapped ${mine} times for this post; Medium allows ${MAX_CLAPS}. At most ${MAX_CLAPS - mine} more.`);
    }
    // Negative claps are how Medium's own "undo claps" works.
    const delta = count > 0 ? count : -mine;
    if (delta === 0) return { changed: false, post: state.title, yourClaps: 0, totalClaps: state.clapCount, message: "You haven't clapped for this post." };
    await this.http.gql(Q.clap, { postId: id, userId: me.id, numClaps: delta }, { requireAuth: true, mutation: true });
    const after = await this.postViewerState(id);
    const nowMine = after.viewerEdge?.clapCount ?? 0;
    return {
      changed: nowMine !== mine,
      post: after.title,
      yourClaps: nowMine,
      totalClaps: after.clapCount,
      message: count > 0 ? `Clapped ${nowMine - mine} time(s); you've now clapped ${nowMine} of ${MAX_CLAPS}.` : `Removed your ${mine - nowMine} clap(s).`,
    };
  }

  async saveToList(postRef: string, listRef = READING_LIST) {
    await this.whoami();
    const id = parsePostId(postRef);
    const list = await this.resolveList(listRef);
    const state = await this.postViewerState(id);
    if (containingLists(state).some((c) => c.list === list.id)) {
      return { changed: false, post: state.title, list: list.name, message: `Already in ${list.name}.` };
    }
    if (list.id === READING_LIST) {
      const r = await this.http.gql<{ addToPredefinedCatalog: { __typename: string } }>(
        Q.addToReadingList,
        { operation: { preprend: { type: "POST", id } } },
        { requireAuth: true, mutation: true },
      );
      failUnlessSuccess(r.addToPredefinedCatalog.__typename, "AddToPredefinedCatalogSucces");
    } else {
      const r = await this.http.gql<{ editCatalogItems: { __typename: string } }>(
        Q.editCatalogItems,
        { catalogId: list.id, version: list.version, operations: [{ preprend: { type: "POST", id } }] },
        { requireAuth: true, mutation: true },
      );
      failUnlessSuccess(r.editCatalogItems.__typename, "EditCatalogItemsSuccess");
    }
    const saved = containingLists(await this.postViewerState(id)).some((c) => c.list === list.id);
    return { changed: saved, post: state.title, list: list.name, message: saved ? `Saved to ${list.name}.` : `Medium accepted the request but the post isn't showing in ${list.name}.` };
  }

  async removeFromList(postRef: string, listRef = READING_LIST) {
    await this.whoami();
    const id = parsePostId(postRef);
    const list = await this.resolveList(listRef);
    const state = await this.postViewerState(id);
    const entry = containingLists(state).find((c) => c.list === list.id);
    if (!entry) return { changed: false, post: state.title, list: list.name, message: `Not in ${list.name}.` };
    const r = await this.http.gql<{ editCatalogItems: { __typename: string } }>(
      Q.editCatalogItems,
      { catalogId: entry.catalogId, version: entry.version, operations: entry.itemIds.map((itemId) => ({ delete: { itemId } })) },
      { requireAuth: true, mutation: true },
    );
    failUnlessSuccess(r.editCatalogItems.__typename, "EditCatalogItemsSuccess");
    const still = containingLists(await this.postViewerState(id)).some((c) => c.list === list.id);
    return { changed: !still, post: state.title, list: list.name, message: still ? `Medium accepted the request but the post is still in ${list.name}.` : `Removed from ${list.name}.` };
  }

  // ---- resolution helpers ----

  private async postViewerState(id: string) {
    type Cat = { catalogId: string; version: string; catalogItemIds: string[]; predefined?: string };
    const data = await this.http.gql<{
      post: {
        id: string;
        title?: string;
        clapCount?: number;
        viewerEdge?: { clapCount?: number; catalogsConnection?: { catalogsContainingThis?: Cat[]; predefinedContainingThis?: Cat[] } | null } | null;
      } | null;
    }>(Q.postViewerState, { id }, { requireAuth: true });
    if (!data.post) throw new MediumError(`No Medium post found with id ${id}.`, 404);
    return data.post;
  }

  private async resolveList(ref: string): Promise<ListInfo> {
    const r = ref.trim();
    if (!r || /^(reading[\s_-]?list|saved|bookmarks?)$/i.test(r)) {
      return { id: READING_LIST, name: "Reading list" };
    }
    const lists = await this.lists();
    const urlId = r.match(/\/list\/(?:[^/?#]*-)?([0-9a-f]{10,14})(?:[/?#]|$)/i)?.[1];
    const exact = lists.find((l) => l.id === (urlId ?? r)) ?? lists.filter((l) => l.name.toLowerCase() === r.toLowerCase());
    if (!Array.isArray(exact)) return exact;
    if (exact.length === 1) return exact[0]!;
    const partial = lists.filter((l) => l.name.toLowerCase().includes(r.toLowerCase()));
    if (partial.length === 1) return partial[0]!;
    const names = (exact.length ? exact : partial.length ? partial : lists).map((l) => `"${l.name}" (${l.id})`).join(", ");
    throw new MediumError(`${exact.length || partial.length ? "More than one list matches" : "No list matches"} "${ref}". Your lists: ${names}.`);
  }

  /**
   * Turn "@user", a profile or publication URL, a publication slug/domain, or a
   * plain name into a Medium account. With `strict`, a plain name must match
   * exactly one account; otherwise the candidates are listed in the error.
   */
  async resolveAccount(ref: string, opts: { strict?: boolean } = {}): Promise<Account & ViewerState> {
    const r = ref.trim();
    const parsed = parseAccountRef(r);
    if (parsed.username) {
      const u = await this.userByUsername(parsed.username);
      if (u) return u;
      // "<name>.medium.com" can be a user or a publication subdomain.
      if (!parsed.slug) throw new MediumError(`No Medium user @${parsed.username}.`, 404);
    }
    // A bare word ("javarevisited", "sam") might be a slug, a username, or just
    // part of a name. For reads, the first slug/username hit is fine. For
    // account changes it has to actually be named that, or it joins the
    // candidates below: "sam" once followed the publication at medium.com/sam,
    // "Sam blog :]".
    const direct: Array<Account & ViewerState> = [];
    if (parsed.slug) {
      const p = await this.publicationBySlug(parsed.slug);
      if (p && (parsed.explicit || !opts.strict || sameName(p.name, r))) return p;
      if (parsed.explicit) throw new MediumError(`No Medium publication or user found at ${ref}.`, 404);
      const u = await this.userByUsername(parsed.slug);
      if (u && (!opts.strict || sameName(u.name, r))) return u;
      direct.push(...[p, u].filter((a) => a !== null));
    }

    // Plain name: search both people and publications.
    const data = await this.http.gql<{
      search: {
        people?: { items?: Array<{ id?: string; name?: string; username?: string; bio?: string | null }> } | null;
        collections?: { items?: Array<{ id: string; name?: string; slug?: string; domain?: string | null; description?: string | null }> } | null;
      } | null;
    }>(Q.searchAccounts, { query: r, paging: { limit: 5, page: 0 } });
    const candidates = dedupeAccounts([
      ...direct.map(stripState),
      ...(data.search?.collections?.items ?? []).map(publicationAccount),
      ...(data.search?.people?.items ?? []).filter((u) => u.id).map((u) => userAccount(u as { id: string })),
    ]);
    const exact = candidates.filter((c) => sameName(c.name, r));
    const pick = exact.length === 1 ? exact[0] : !opts.strict && candidates.length ? (exact[0] ?? candidates[0]) : undefined;
    if (pick) {
      return pick.kind === "user" ? ((await this.userByUsername(pick.username!)) ?? pick) : ((await this.publicationBySlug(pick.slug ?? pick.id)) ?? pick);
    }
    if (!candidates.length) throw new MediumError(`No Medium author or publication matches "${ref}".`, 404);
    const list = candidates.map((c) => `${c.name} (${c.kind === "user" ? "@" + c.username : c.slug}) ${c.url}`).join("; ");
    throw new MediumError(`"${ref}" is ambiguous. Pass one of these exactly: ${list}`);
  }

  private async userByUsername(username: string) {
    type U = { __typename: string; id: string; name?: string; username?: string; bio?: string | null; viewerEdge?: ViewerState | null };
    const data = await this.http.gql<{ userResult: U | null }>(Q.user, { username });
    const u = data.userResult;
    if (!u || u.__typename !== "User") return null;
    return { ...userAccount(u), isFollowing: u.viewerEdge?.isFollowing, isMuting: u.viewerEdge?.isMuting };
  }

  private async publicationBySlug(slug: string) {
    type C = { id: string; name?: string; slug?: string; domain?: string | null; description?: string | null; viewerEdge?: ViewerState | null };
    const data = await this.http.gql<{ collectionByDomainOrSlug: C | null }>(Q.publication, { slug }).catch((err: unknown) => {
      if (err instanceof MediumError && !(err instanceof AuthError)) return { collectionByDomainOrSlug: null };
      throw err;
    });
    const c = data.collectionByDomainOrSlug;
    return c ? { ...publicationAccount(c), isFollowing: c.viewerEdge?.isFollowing, isMuting: c.viewerEdge?.isMuting } : null;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Medium post ids are 8–12 hex characters. They end every post URL
 * (`/@user/some-title-1a2b3c4d5e6f`, `pub.domain/title-<id>`, `/p/<id>`), so a
 * custom-domain link needs no lookup.
 */
export function parsePostId(ref: string): string {
  const r = ref.trim();
  if (/^[0-9a-f]{8,12}$/i.test(r)) return r.toLowerCase();
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(r) ? r : `https://${r}`);
  } catch {
    throw new MediumError(`"${ref}" isn't a Medium post URL or id.`);
  }
  const redirect = url.searchParams.get("redirectUrl");
  if (redirect) return parsePostId(redirect);
  const segments = url.pathname.split("/").filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const m = decodeURIComponent(segments[i]!).match(/(?:^|-)([0-9a-f]{8,12})$/i);
    if (m) return m[1]!.toLowerCase();
  }
  throw new MediumError(`Couldn't find a post id in "${ref}". Medium post URLs end in a hex id like -1a2b3c4d5e6f.`);
}

/** Recognise "@user", profile URLs, publication URLs/domains, and slugs. */
export function parseAccountRef(ref: string): { username?: string; slug?: string; explicit?: boolean } {
  const r = ref.trim();
  if (/^@[\w.-]+$/.test(r)) return { username: r.slice(1) };
  if (/\s/.test(r)) return {};
  const looksLikeUrl = /^https?:\/\//i.test(r) || /^[\w-]+(\.[\w-]+)+(\/|$)/.test(r);
  if (!looksLikeUrl) return /^[\w-]+$/.test(r) ? { slug: r.toLowerCase() } : {};
  const url = new URL(/^https?:\/\//i.test(r) ? r : `https://${r}`);
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const first = url.pathname.split("/").filter(Boolean)[0];
  if (host === "medium.com") {
    if (first?.startsWith("@")) return { username: first.slice(1), explicit: true };
    if (first) return { slug: first.toLowerCase(), explicit: true };
    return {};
  }
  if (host.endsWith(".medium.com")) {
    const sub = host.slice(0, -".medium.com".length);
    return { username: sub, slug: sub, explicit: true };
  }
  // Custom domain: publications are looked up by domain.
  return { slug: host, explicit: true };
}

export function summarize(p: RawPost): PostSummary {
  return {
    id: p.id,
    title: p.title || "(untitled)",
    subtitle: p.extendedPreviewContent?.subtitle || undefined,
    author: p.creator?.name ?? undefined,
    authorUsername: p.creator?.username ?? undefined,
    publication: p.collection?.name ?? undefined,
    url: p.mediumUrl ?? undefined,
    published: p.firstPublishedAt ? new Date(p.firstPublishedAt).toISOString() : undefined,
    readingMinutes: p.readingTime ? Math.max(1, Math.round(p.readingTime)) : undefined,
    claps: p.clapCount ?? undefined,
    memberOnly: Boolean(p.isLocked),
  };
}

function userAccount(u: { id: string; name?: string | null; username?: string | null; bio?: string | null }): Account {
  return {
    kind: "user",
    id: u.id,
    name: u.name ?? undefined,
    username: u.username ?? undefined,
    url: u.username ? `https://medium.com/@${u.username}` : `https://medium.com/u/${u.id}`,
    description: u.bio || undefined,
  };
}

function publicationAccount(c: { id: string; name?: string | null; slug?: string | null; domain?: string | null; description?: string | null }): Account {
  return {
    kind: "publication",
    id: c.id,
    name: c.name ?? undefined,
    slug: c.slug ?? undefined,
    url: c.domain ? `https://${c.domain}` : `https://medium.com/${c.slug ?? c.id}`,
    description: c.description || undefined,
  };
}

function sameName(name: string | undefined, ref: string): boolean {
  return Boolean(name) && name!.trim().toLowerCase() === ref.trim().toLowerCase();
}

function dedupeAccounts(accounts: Account[]): Account[] {
  const seen = new Set<string>();
  return accounts.filter((a) => !seen.has(a.kind + a.id) && Boolean(seen.add(a.kind + a.id)));
}

/** The viewer's relationship to an account, as Medium reports it. */
type ViewerState = { isFollowing?: boolean; isMuting?: boolean };

function stripState<T extends ViewerState>(a: T): Omit<T, keyof ViewerState> {
  const { isFollowing: _f, isMuting: _m, ...rest } = a;
  return rest;
}

function containingLists(state: {
  viewerEdge?: {
    catalogsConnection?: {
      catalogsContainingThis?: Array<{ catalogId: string; version: string; catalogItemIds: string[] }>;
      predefinedContainingThis?: Array<{ catalogId: string; version: string; catalogItemIds: string[]; predefined?: string }>;
    } | null;
  } | null;
}) {
  const conn = state.viewerEdge?.catalogsConnection;
  return [
    ...(conn?.predefinedContainingThis ?? [])
      .filter((c) => c.predefined === "READING_LIST")
      .map((c) => ({ list: READING_LIST, catalogId: c.catalogId, version: c.version, itemIds: c.catalogItemIds })),
    ...(conn?.catalogsContainingThis ?? []).map((c) => ({ list: c.catalogId, catalogId: c.catalogId, version: c.version, itemIds: c.catalogItemIds })),
  ];
}

function failUnlessSuccess(typename: string, expected: string): void {
  if (typename !== expected) throw new MediumError(`Medium refused the change (${typename}).`);
}

/** Medium's PagingOptions reject nulls and unknown empty strings. */
/** Medium rejects followingUserConnection pages over 25. */
const FOLLOWING_PAGE = 25;
/** Medium's reading-history page size; it ignores other limits. */
const HISTORY_PAGE = 15;

function cleanPaging(p: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(p).filter(([, v]) => v !== null && v !== undefined && v !== ""));
}

export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeCursor<T>(cursor: string | undefined): T | null {
  if (!cursor) return null;
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as T;
  } catch {
    throw new MediumError("That cursor isn't valid. Pass the nextCursor value exactly as returned.");
  }
}
