# Agent notes

Common mistakes and confusion points in this project. Add to this list when something surprises you.

## Medium API quirks

- There is no usable official Medium API for any of this. Medium's OAuth/integration-token API stopped issuing tokens on 2025-01-01, and it never had feed or read endpoints anyway. Everything here uses `POST https://medium.com/_/graphql`, the endpoint medium.com's own web app uses, and any of it can change without notice.
- **Cloudflare rules (checked 2026-09-25):** `curl` gets a 403 "Attention Required" page even with a Chrome User-Agent. Headless Chrome gets it too, because its UA says `HeadlessChrome`. **Node over HTTP/1.1 with a normal Chrome UA gets through, with no cookies.** Without a UA, Node also gets the 403. That's why `USER_AGENT` in `config.ts` exists and why `login` runs a **headed** browser. `BlockedError` is what a Cloudflare page turns into. **Cloudflare blocks HTTP/2 from undici, and Node 26's `fetch` uses HTTP/2** (checked 2026-09-25). undici 8, which Node 26 bundles, sets `allowH2` on by default. The same request over HTTP/1.1 returns 200 on Node 26, whether it goes through `node:https` or undici with `allowH2: false`. undici with `allowH2: true` returns 403 on Node 24 too. It's not OpenSSL: Node 24 also ships OpenSSL 3.5, and changing the post-quantum key share (`tls.DEFAULT_ECDH_CURVE`) did nothing. That's why `http.ts` sends requests through the npm `undici` package with `new Agent({ allowH2: false })` rather than the global `fetch`. Keep `allowH2: false` explicit so upgrading to undici 8 doesn't break it. If Node starts getting blocked too, the fallbacks are to save `cf_clearance` plus the exact UA from the login browser, or to run the fetch inside a Playwright page.
- **The session needs both `sid` and `uid` cookies.** With `sid` alone, Medium doesn't return an error. It just serves the request as logged out: `viewer` is `null` and `followingFeed` is empty. `whoami` treats a null viewer as an expired session for that reason, and `validateAndSave` refuses a paste that has no `uid`. The `sid` looks like `1:<base64-ish>` and lasts about 13 months. Anonymous visitors get a `uid` of `lo_…` but no `sid`.
- The GraphQL endpoint **accepts ad-hoc query text** (no persisted-query hashes), in a batched body `[{operationName, query, variables}]`, and the response is an array too. **Introspection is disabled.** To learn the schema:
  - The web app's bundles (`cdn-client.medium.com/lite/assets/*.js`, Vite ESM chunks that import each other by relative path) embed every operation as a compiled AST literal: `{kind:"Document",definitions:[…]}` with its fragments inlined. Crawl the module graph starting from a page's `<script>` tags (article, `/@user/following`, `/@user/lists`, `/search`, a publication page each pull in different chunks). Then cut out each `{kind:"Document"…}` literal with a string-aware brace matcher, `eval` it, and run it through `graphql`'s `print()`. That gave about 260 operations in September 2026.
  - Field-name errors come back with suggestions ("Did you mean `homepagePostsConnection`…?"), which is the quickest way to find a field on a type.
- Member-only posts: `post.isLocked` describes the *post*, not the viewer. What the viewer actually got is `post.viewerEdge.fullContent.isLockedPreviewOnly`. Anonymous or non-member viewers get a truncated body of about 150–250 words from both `content` and `fullContent`, while `wordCount` still reports the full length. For a member both return the full body (verified: 2,704 of 2,709 words).
- **Reading a post through the API does not add it to the user's reading history** (`viewer.readingHistory` didn't change after a `fullContent` read, 2026-09-25). Don't open posts in a browser to test things, because that probably does.
- Post bodies are a `bodyModel`: typed paragraphs (`P H2 H3 H4 IMG PRE BQ PQ ULI OLI IFRAME MIXTAPE_EMBED`) with markups (`STRONG EM CODE A`) given as `[start, end)` offsets. Several things in there are easy to get wrong:
  - The body repeats the title as a heading, often *after* a lead image, and usually follows it with the subtitle as an H4.
  - `codeBlockMetadata.lang` with `mode: "AUTO"` is Medium's guess and is often wrong (`ini` for Python). Only trust it when the author picked it.
  - Markup ranges often include surrounding spaces, which breaks Markdown emphasis. `format.ts` trims them and keeps whitespace outside the markers.
  - Consecutive `PRE` paragraphs are one code block.
- **Publication posts:** `Collection.latestPostsConnection` **ignores every paging argument** (always the same first page, `next.from: null`). Use `homepagePostsConnection` (the user equivalent is `User.homepagePostsConnection`). **Without a cursor it returns pinned posts first**, paged with `from: "P<timestamp>"`, and only then the rest newest first with `from: "L<timestamp>"`. A publication with several pins (Towards AI has 4+) looks months stale. Start at `from: "L<now>"` to skip the pins; authors pin too. Found 2026-09-25 by testing through the MCP tools, not the unit tests.
- Paging objects (`PagingOptions`) reject `null`s, and the feed's `next.source` is often `""`. `cleanPaging` drops both.
- `followingCollectionConnection` (publications the user follows) has no paging and returns everything at once (over 150 items on a test account). `followingUserConnection` pages with `from` and **rejects `limit` over 25**, so `following()` fetches several pages to fill a larger limit. `socialStats.followingCount` is higher than what the connection returns (945 vs 802 on a test account, with every page full up to the last). The gap is probably accounts Medium no longer lists; that's unverified.
- Reading history is `viewer.readingHistory.postPreviewConnection(paging)` → `postPreviews { postId post }`. It's in fixed pages of 15, whatever `limit` you pass, and paged by `next.to` (a timestamp) plus `page`. There's no read date per post, so it's ordered by last read with no dates. Deleted posts come back with `post: null`. **Never call `resetUserReadingHistory`**: it wipes the user's history, and there's no undo.
- Some IDs are typed `ID!`, not `String!`, even when they look like strings (`collectionByDomainOrSlug(domainOrSlug:)`, `catalogById(catalogId:)`). The wrong type is a validation error, not a coercion.
- Lists are "catalogs":
  - The reading list is `getPredefinedCatalog(userId, type: READING_LIST)`, whose id looks like `predefined:<userId>:READING_LIST`. Named lists come from `catalogsByUser(type: LISTS)` and `catalogById`.
  - Items page with `pagingOptions: {limit, cursor: {id: "offset:N"}}`.
  - Deleted posts show up as items whose `entity` is `null`.
- Mutations only need the session cookies plus `Origin`/`Referer`. There's no CSRF token (verified 2026-09-25):
  - `followUser` / `unfollowUser(targetUserId)`, `followCollection` / `unfollowCollection(targetCollectionId)`.
  - `clap(targetPostId, userId, numClaps)`: **a negative `numClaps` removes claps**, which is how undo works. The cap is 50 per reader per post, and `viewerEdge.clapCount` is the viewer's own count.
  - Reading list: `addToPredefinedCatalog(type: READING_LIST, operation: {preprend: {type: POST, id}})`. **Yes, `preprend`**, and the success typename really is `AddToPredefinedCatalogSucces`.
  - Named lists and all removals: `editCatalogItems(catalogId, version, operations: [{preprend: {type, id}}] | [{delete: {itemId}}])`. It needs the catalog's current `version`. Take the catalog id, version and item ids from `post.viewerEdge.catalogsConnection` (`predefinedContainingThis` / `catalogsContainingThis`).
  - Every write in `api.ts` re-reads state afterwards, because the mutation's echo isn't proof. Keep it that way.
- Post IDs are 8–12 hex characters at the end of every post URL, including custom domains (`pub.towardsai.net/<slug>-<id>`). GraphQL on medium.com serves any post by id, so custom domains need no cookie handoff (unlike Substack).
- `<name>.medium.com` can be a user *or* a publication. `resolveAccount` tries user first, then publication.
- A bare word is tried as a publication slug and a username. For account changes (`strict`), a hit only counts if its display name matches what was asked; otherwise it joins the ambiguity list. Before this, `follow("sam")` followed `medium.com/sam` ("Sam blog :]").

## Testing against a real account

- Account-changing calls affect real people: authors get notified of follows and claps, and named lists are public. Ask before testing them live, and reverse every change. The reading list is private.

## MCP / Claude Code

- In server mode **stdout is the MCP protocol channel.** Never `console.log` from server code paths; use `console.error`. CLI subcommands (`status`, `logout`, `install`) may use stdout.
- Claude Code does not read MCP servers from `~/.claude/settings.json`. Use `claude mcp add` (what `cli.ts install` does) or `~/.claude.json` / `.mcp.json`.

## Tooling

- TypeScript is 7.x, the native compiler. Some older tsconfig options (`baseUrl`, `moduleResolution: node`) no longer exist.
- If vitest fails with `Cannot find native binding` (rolldown), it's the npm optional-dependency bug: delete `node_modules` and `package-lock.json`, then run `npm install` again.
- `playwright-core` is an **optional** dependency and is imported dynamically only by `login`. Don't import it at the top level of anything the server loads.
