import { shorten } from "../src/digest/finish.js";
import { describe, expect, it } from "vitest";
import { alsoNewLines, formatClaps, formatLocal, renderDigest, shortReason } from "../src/digest/render.js";
import type { Judgments, RunFile, RunItem } from "../src/digest/types.js";

function item(ref: string, extra: Partial<RunItem> = {}): RunItem {
  const pool = ref[0] === "F" ? "following" : ref[0] === "T" ? "top" : "for_you";
  const n = Number(ref.slice(1));
  return {
    ref,
    id: (n + (pool === "following" ? 0 : pool === "top" ? 1000 : 2000)).toString(16).padStart(12, "0"),
    pool,
    title: `Post ${ref}`,
    author: `Author ${ref}`,
    url: `https://medium.com/p/${ref.toLowerCase()}`,
    memberOnly: false,
    read: false,
    ...extra,
  };
}

function runWith(items: RunItem[]): RunFile {
  return {
    version: 1,
    run_id: "20261002T121531Z",
    started_at: "2026-10-02T12:15:31Z",
    since: "2026-10-01T12:15:24Z",
    member: true,
    tz: "America/Denver",
    style: "discord",
    counts: { following_new: items.filter((i) => i.pool === "following").length, following_reported: 0, top: 0, top_dropped: 0, for_you: 0, for_you_dropped: 0, for_you_range: [25, 100] },
    rater: { status: "ok", threshold: 0.7, skipped: 0 },
    history: { authors: [], publications: [] },
    warnings: [],
    items,
  };
}

const none: Judgments = { starred: [], following: [], top_picks: [], for_you: [], preview_only: [], unreadable: [], extra_skipped: [] };

describe("formatLocal", () => {
  it("converts to the zone, including daylight saving and the date change", () => {
    expect(formatLocal("2026-10-02T12:00:24Z", "America/Denver")).toBe("Fri, Oct 2, 6:00 AM MDT");
    expect(formatLocal("2026-09-25T02:40:30Z", "America/Denver")).toBe("Thu, Sep 24, 8:40 PM MDT");
    expect(formatLocal("2026-11-20T02:40:30Z", "America/Denver")).toBe("Thu, Nov 19, 7:40 PM MST");
    expect(formatLocal("2026-12-02T12:00:00Z", "UTC")).toBe("Wed, Dec 2, 12:00 PM UTC");
  });
});

describe("small formatters", () => {
  it("formats claps and shortens reasons", () => {
    expect([950, 1000, 1234, 12_345, 1_300_000].map(formatClaps)).toEqual(["950", "1k", "1.2k", "12k", "1.3M"]);
    expect(formatClaps(undefined)).toBe("-");
    expect(shortReason("Because you follow Coding")).toBe("follow:Coding");
    expect(shortReason("Based on your reading history")).toBe("history");
    expect(shortReason("From your network")).toBe("network");
    expect(shortReason("Selected for you")).toBe("selected");
    expect(shortReason("Ann Lee clapped")).toBe("clap:Ann Lee");
  });
});

describe("alsoNewLines", () => {
  it("groups by publication, largest first, three links then +k, authors on one line, brackets escaped", () => {
    const items = [
      item("F1", { publication: "Small" }),
      item("F2"),
      ...["F3", "F4", "F5", "F6", "F7"].map((r) => item(r, { publication: "Big" })),
      item("F8", { title: "Arrays [part 2] *bold*" }),
    ];
    expect(alsoNewLines(items, "discord")).toEqual([
      "**Big** (5) · [Post F3](<https://medium.com/p/f3>) · [Post F4](<https://medium.com/p/f4>) · [Post F5](<https://medium.com/p/f5>) +2",
      "**Authors** (2) · [Post F2](<https://medium.com/p/f2>) · [Arrays \\[part 2\\] \\*bold\\*](<https://medium.com/p/f8>)",
      "**Small** (1) · [Post F1](<https://medium.com/p/f1>)",
    ]);
    expect(alsoNewLines([item("F1")], "markdown")).toEqual(["**Authors** (1) · [Post F1](https://medium.com/p/f1)"]);
  });
});

describe("renderDigest", () => {
  it("is [SILENT] when there's nothing to say", () => {
    expect(renderDigest(runWith([]), none).message).toBe("[SILENT]");
    // Only skipped posts: still nothing to say.
    expect(renderDigest(runWith([item("F1", { skipped: true })]), none).message).toBe("[SILENT]");
  });

  it("keeps starred posts out of their section and out of Also new; counts skips with (mostly …)", () => {
    const items = [
      item("F1", { publication: "Pub", memberOnly: true }),
      item("F2"),
      item("F3", { author: "Spammy", skipped: true }),
      item("F4", { author: "Spammy", skipped: true }),
      item("F5", { author: "Spammy" }),
      item("F6", { author: "Other", skipped: true }),
      item("T1", { reason: "Selected for you" }),
      item("Y1", { reason: "Based on your reading history" }),
      item("Y2"),
    ];
    const j: Judgments = {
      ...none,
      starred: [{ ref: "F1", gist: "The gist.", why: "Original data." }],
      following: [{ ref: "F2", gist: "Short one." }],
      top_picks: [{ ref: "T1", gist: "Top gist." }],
      for_you: [{ ref: "Y1", gist: "Yours." }],
      preview_only: ["F1"],
      unreadable: ["Y2"],
      extra_skipped: ["F5"],
    };
    const { message, counts } = renderDigest(runWith(items), j);
    expect(counts).toEqual({ named: 5, readInFull: 4, alsoNew: 0, skipped: 4, unreadable: 1 });
    expect(message).toMatchInlineSnapshot(`
      "📰 **Medium** — 6 new in Following, 4 read in full (since Thu, Oct 1, 6:15 AM MDT)

      ⭐ **Read in full**
      1. **Post F1** — Author F1, Pub [member] (preview only)
         The gist.
         _Why:_ Original data.
         https://medium.com/p/f1

      👥 **Following**
      • **Post F2** — Author F2 · Short one. https://medium.com/p/f2

      🔥 **Medium's top picks**
      • **Post T1** — Author T1 · Top gist. · _Selected for you_ https://medium.com/p/t1

      🎯 **For you**
      • **Post Y1** — Author Y1 · Yours. · _Based on your reading history_ https://medium.com/p/y1

      ⚠ **Couldn't read**
      • Post Y2 https://medium.com/p/y2

      🗑 Skipped 4 as clickbait (mostly Spammy)"
    `);
  });

  it("lists the rest of Following under Also new, and needs 3 skips for (mostly …)", () => {
    const items = [item("F1", { publication: "Pub" }), item("F2", { publication: "Pub" }), item("F3", { skipped: true, author: "X" }), item("F4", { skipped: true, author: "X" })];
    const { message } = renderDigest(runWith(items), { ...none, following: [{ ref: "F1", gist: "g" }] });
    expect(message).toContain("_Also new_\n**Pub** (1) · [Post F2](<https://medium.com/p/f2>)");
    expect(message).toMatch(/🗑 Skipped 2 as clickbait$/);
  });
});

describe("shorten", () => {
  it("leaves short text alone", () => {
    expect(shorten("Short gist.", 50)).toBe("Short gist.");
  });

  it("cuts at a clause break, never mid-word", () => {
    const t =
      "Svalbard's 1920 treaty gives 46 nations' citizens visa-free unlimited residence/work rights, provided they're self-sufficient; outside Longyearbyen, carrying a firearm for polar bears is legally required.";
    const out = shorten(t, 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).toBe("Svalbard's 1920 treaty gives 46 nations' citizens visa-free unlimited residence/work rights, provided they're self-sufficient; outside Longyearbyen…");
  });

  it("keeps a whole sentence when one fits", () => {
    expect(shorten("First sentence is here and fairly long. Second one runs on and on past the limit.", 60)).toBe("First sentence is here and fairly long.");
  });

  it("falls back to a word break when the only clause break is early", () => {
    expect(shorten("Hi, this sentence keeps going without any further punctuation at all", 40)).toBe("Hi, this sentence keeps going without…");
  });
});
