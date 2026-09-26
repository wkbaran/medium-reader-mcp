import { describe, expect, it } from "vitest";
import { inline, markdownToText, paragraphsToMarkdown, type Paragraph } from "../src/format.js";

const P = (text: string, markups: Paragraph["markups"] = []): Paragraph => ({ type: "P", text, markups });

describe("inline markups", () => {
  it("applies bold, italic, code, and links", () => {
    expect(inline(P("a bold word", [{ type: "STRONG", start: 2, end: 6 }]))).toBe("a **bold** word");
    expect(inline(P("see docs", [{ type: "A", start: 4, end: 8, href: "https://d" }]))).toBe("see [docs](https://d)");
    expect(inline(P("run npm ci now", [{ type: "CODE", start: 4, end: 10 }]))).toBe("run `npm ci` now");
  });

  it("splits overlapping ranges into valid runs", () => {
    const text = "bold both bold";
    expect(inline(P(text, [{ type: "STRONG", start: 0, end: 14 }, { type: "EM", start: 5, end: 9 }]))).toBe("**bold** **_both_** **bold**");
  });

  it("keeps whitespace outside markers", () => {
    expect(inline(P("x bold y", [{ type: "STRONG", start: 1, end: 7 }]))).toBe("x **bold** y");
    expect(inline(P("go here now", [{ type: "A", start: 2, end: 8, href: "https://h" }]))).toBe("go [here](https://h) now");
  });

  it("doesn't nest emphasis inside code", () => {
    expect(inline(P("call x()", [{ type: "CODE", start: 5, end: 8 }, { type: "STRONG", start: 0, end: 8 }]))).toBe("**call** `x()`");
  });

  it("leaves double underscores in plain text alone", () => {
    expect(inline(P("self.__init__ runs", [{ type: "EM", start: 14, end: 18 }]))).toBe("self.__init__ _runs_");
  });

  it("links @mentions to the user's profile", () => {
    expect(inline(P("thanks Ann", [{ type: "A", start: 7, end: 10, anchorType: "USER", userId: "u1" }]))).toBe("thanks [Ann](https://medium.com/u/u1)");
  });
});

describe("paragraphsToMarkdown", () => {
  it("drops the repeated title and subtitle, even after a lead image", () => {
    const md = paragraphsToMarkdown(
      [
        { type: "IMG", text: "", metadata: { id: "img", alt: "" } },
        { type: "H3", text: "My Title" },
        { type: "H4", text: "The subtitle" },
        P("Body."),
      ],
      { title: "My Title" },
    );
    expect(md).toBe("Body.");
  });

  it("keeps a heading that only looks like the title further down", () => {
    const md = paragraphsToMarkdown([P("a"), P("b"), P("c"), { type: "H3", text: "My Title" }], { title: "My Title" });
    expect(md).toContain("## My Title");
  });

  it("merges consecutive code paragraphs and ignores guessed languages", () => {
    const md = paragraphsToMarkdown([
      { type: "PRE", text: "x = 1", codeBlockMetadata: { lang: "ini", mode: "AUTO" } },
      { type: "PRE", text: "y = 2", codeBlockMetadata: { lang: "ini", mode: "AUTO" } },
      P("then"),
      { type: "PRE", text: "fn main() {}", codeBlockMetadata: { lang: "rust", mode: "EXPLICIT" } },
    ]);
    expect(md).toBe("```\nx = 1\ny = 2\n```\n\nthen\n\n```rust\nfn main() {}\n```");
  });

  it("uses a longer fence when the code contains backticks", () => {
    expect(paragraphsToMarkdown([{ type: "PRE", text: "```js" }])).toBe("````\n```js\n````");
  });

  it("numbers ordered lists and bullets unordered ones", () => {
    const md = paragraphsToMarkdown([
      { type: "OLI", text: "one" },
      { type: "OLI", text: "two" },
      { type: "ULI", text: "dot" },
    ]);
    expect(md).toBe("1. one\n2. two\n\n- dot");
  });

  it("renders quotes, headings, embeds, and link cards", () => {
    const md = paragraphsToMarkdown([
      { type: "H3", text: "Section" },
      { type: "H4", text: "Sub" },
      { type: "BQ", text: "said" },
      { type: "PQ", text: "pulled" },
      { type: "IFRAME", text: "", iframe: { mediaResource: { href: "https://youtu.be/x", title: "Video" } } },
      { type: "MIXTAPE_EMBED", text: "Other post\nIts description", mixtapeMetadata: { href: "https://medium.com/p/1" } },
    ]);
    expect(md).toBe(
      "## Section\n\n### Sub\n\n> said\n\n> _pulled_\n\n[embed: Video](https://youtu.be/x)\n\n[Other post](https://medium.com/p/1)",
    );
  });

  it("turns images into placeholders and drops ones with nothing to say", () => {
    const md = paragraphsToMarkdown([
      { type: "IMG", text: "", metadata: { id: "a", alt: "" } },
      { type: "IMG", text: "A caption", metadata: { id: "b", alt: "" } },
      { type: "IMG", text: "Credit: me", metadata: { id: "c", alt: "A cat" } },
    ]);
    expect(md).toBe("[image: A caption]\n\n[image: A cat]\n_Credit: me_");
  });
});

describe("markdownToText", () => {
  it("strips Markdown syntax", () => {
    expect(markdownToText("## Head\n\n**bold** and [link](https://x)\n\n> quote\n\n```\ncode\n```")).toBe("Head\n\nbold and link\n\nquote\n\ncode");
  });
});
