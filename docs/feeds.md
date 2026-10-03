# How Medium's feeds behave

Findings from probing Medium's GraphQL API with this server's session in September 2026. They come from one account on one day, so they're observations, not documented behaviour; Medium can change any of it without notice. The digest's design (which "For you" positions it reads, and why it never pages far) follows from them.

## "For you" is a fixed list of about 1,000 posts

- **Medium builds the list once and keeps serving it.** The paging cursor is a `source` ID (a UUID naming the list) plus an offset (`to: 25, 50, … 975`). Three fetches in a row returned the same 50 posts in the same order.
- **Paging past the end builds a new list.** After about 39 pages of 25, the next page comes from a new `source`, and later fetches, including the first page, use it.
  - The new list is mostly the same posts reordered: a second list added only 15 new posts, and the first 300 of a third added none.
  - Going deeper reshuffles roughly the same 1,000 candidates; it doesn't reach older posts.
- **Posts range up to about a year old:** median 7 days, a quarter older than 30 days, 5% older than about 3 months, oldest 356 days.
- **Heads-up:** paging to the end of "For you" rebuilds the list your homepage shows. `get_feed` returns at most 100 posts per call, so this only happens if you follow `nextCursor` about ten times.
- **Not measured:** whether a list also expires after some time.

## The order means something, but the top isn't "most like you"

All 975 posts of one list, compared by position. "Read" means the author or publication appears in the account's reading history.

| Positions | Median age (days) | Median claps | Author you follow | Author you've read | Publication you've read |
|---|---|---|---|---|---|
| **0–25** | 22 | **1,554** | 16% | 32% | 36% |
| 25–100 | 8 | 374 | **32%** | **47%** | 36% |
| 100–250 | 11 | 411 | 24% | **47%** | 32% |
| 250–500 | 9 | 206 | 18% | 37% | 46% |
| 500–750 | 7 | 168 | 8% | 18% | 45% |
| 750–975 | 4 | 142 | 1% | 4% | 44% |

The share of member-only posts (about 75–85%) and median reading time (5–8 minutes) barely change with depth.

- **0–25: popular, proven posts spread across your topics.** They're older, with 4–10× the claps of anything deeper. One post per followed topic ("Because you follow Startup", "…Humor"), plus "Selected for you".
- **25–250: the most personal part.** It has the highest shares of authors you follow and authors you've read.
- **500+: fresh, low-clap posts,** increasingly there because of network activity ("*Someone* clapped"). By the end, almost none are from authors you've read.

So for what a reader would pick, positions 25–250 matter more than the first page, which shows what Medium promotes to everyone. Each item's `reason` field (`reasonString` in GraphQL) says why it was included.

## The Following feed

- **It's every post from authors and publications you follow, roughly newest first.** On the test account about 94% came through publications, at 190 posts a day, so a few high-volume publications made up most of it.
- **Reading a post doesn't remove it** from the feed.
- **Unfollowing a publication didn't remove posts already in the feed.** Muting worked immediately, and **muting an author** also hides their posts in publications you still follow. That's the only way to cut a prolific writer out of a publication you want to keep.
- **"I'm not interested in this story"** (`SHOW_LESS`) doesn't remove the post from Following. The web app just hides it on the page.

## Reproducing this

`get_feed` (`feed: "for_you"`), `list_following` and `get_reading_history` return everything used here. [CLAUDE.md](../CLAUDE.md) has the GraphQL details.
