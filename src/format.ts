/**
 * Medium doesn't serve post HTML through its API. Bodies come as a `bodyModel`:
 * a flat list of typed paragraphs, each with plain text plus "markups" (bold,
 * links, ...) given as [start, end) offsets into that text. This turns that
 * model into Markdown.
 */

export interface Markup {
  type: string; // STRONG | EM | CODE | A
  start: number;
  end: number;
  href?: string | null;
  anchorType?: string | null; // LINK | USER | POST
  userId?: string | null;
}

export interface Paragraph {
  name?: string;
  type: string; // P | H2 | H3 | H4 | IMG | PRE | BQ | PQ | ULI | OLI | IFRAME | MIXTAPE_EMBED
  text?: string | null;
  href?: string | null;
  markups?: Markup[] | null;
  metadata?: { id?: string | null; alt?: string | null } | null;
  mixtapeMetadata?: { href?: string | null } | null;
  iframe?: { mediaResource?: { href?: string | null; iframeSrc?: string | null; title?: string | null } | null } | null;
  codeBlockMetadata?: { lang?: string | null; mode?: string | null } | null;
}

export type BodyFormat = "markdown" | "text";

export function paragraphsToMarkdown(input: Paragraph[], opts: { title?: string } = {}): string {
  const paragraphs = opts.title ? dropTitleEcho(input, opts.title) : input;
  const out: string[] = [];
  let i = 0;

  while (i < paragraphs.length) {
    const p = paragraphs[i]!;
    switch (p.type) {
      case "PRE": {
        // Consecutive PRE paragraphs are one code block split by blank lines in the editor.
        const lines: string[] = [];
        // Medium guesses a language for every block ("AUTO") and often guesses wrong; only trust one the author picked.
        const meta = p.codeBlockMetadata;
        const lang = meta?.lang && meta.mode !== "AUTO" ? meta.lang : "";
        while (i < paragraphs.length && paragraphs[i]!.type === "PRE") lines.push(paragraphs[i++]!.text ?? "");
        const code = lines.join("\n");
        const fence = code.includes("```") ? "````" : "```";
        out.push(`${fence}${lang}\n${code}\n${fence}`);
        continue;
      }
      case "ULI":
      case "OLI": {
        const type = p.type;
        const items: string[] = [];
        let n = 1;
        while (i < paragraphs.length && paragraphs[i]!.type === type) {
          items.push(`${type === "OLI" ? `${n++}.` : "-"} ${inline(paragraphs[i++]!)}`);
        }
        out.push(items.join("\n"));
        continue;
      }
      default: {
        const block = renderBlock(p);
        if (block) out.push(block);
        i++;
      }
    }
  }
  return out.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function markdownToText(md: string): string {
  return md
    .replace(/^`{3,}.*$/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/(\*\*|__|\*|_|`)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function renderBlock(p: Paragraph): string {
  const text = inline(p);
  switch (p.type) {
    case "H2":
    case "H3":
      return text ? `## ${text}` : "";
    case "H4":
      return text ? `### ${text}` : "";
    case "BQ":
      return text ? quote(text) : "";
    case "PQ":
      return text ? quote(`_${text}_`) : "";
    case "IMG": {
      // The model can't see images, so they become a short placeholder; an image
      // with neither alt text nor a caption says nothing and is dropped.
      const alt = p.metadata?.alt?.trim();
      const caption = p.text?.trim();
      if (!alt && !caption) return "";
      if (!alt) return `[image: ${text}]`;
      return caption && caption !== alt ? `[image: ${alt}]\n_${text}_` : `[image: ${alt}]`;
    }
    case "IFRAME": {
      const res = p.iframe?.mediaResource;
      const href = res?.href || res?.iframeSrc;
      const title = res?.title || p.text || "embedded content";
      return href ? `[embed: ${title}](${href})` : `[embed: ${title}]`;
    }
    case "MIXTAPE_EMBED": {
      // Link cards: the text is the linked page's title and description.
      const href = p.mixtapeMetadata?.href || p.markups?.find((m) => m.type === "A" && m.href)?.href;
      const label = (p.text ?? "").split("\n")[0]!.trim() || href || "";
      return href ? `[${label}](${href})` : label;
    }
    default:
      return text;
  }
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}

/**
 * Medium repeats the title as a heading near the top of the body, usually after
 * a lead image, and often follows it with the subtitle as an H4. The header
 * already shows both.
 */
function dropTitleEcho(paragraphs: Paragraph[], title: string): Paragraph[] {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const at = paragraphs
    .slice(0, 3)
    .findIndex((p) => ["H2", "H3", "H4"].includes(p.type) && norm(p.text ?? "") === norm(title));
  if (at === -1) return paragraphs;
  const drop = paragraphs[at + 1]?.type === "H4" ? 2 : 1;
  return [...paragraphs.slice(0, at), ...paragraphs.slice(at + drop)];
}

const MARKERS: Record<string, [string, string]> = {
  STRONG: ["**", "**"],
  EM: ["_", "_"],
  CODE: ["`", "`"],
};

/** Apply a paragraph's markups to its text. Overlapping ranges are split into runs with one set of styles each. */
export function inline(p: Paragraph): string {
  const text = p.text ?? "";
  const markups = (p.markups ?? [])
    .map((m) => trimRange(text, m))
    .filter((m): m is Markup => m !== null && (m.type in MARKERS || m.type === "A"));
  if (!markups.length) return text;

  // Cut the text wherever a markup opens or closes, then merge neighbours that
  // ended up with the same styles and link.
  const points = [...new Set([0, text.length, ...markups.flatMap((m) => [m.start, m.end])])].sort((a, b) => a - b);
  const runs: Array<{ text: string; styles: string; href: string | null }> = [];
  for (let k = 0; k < points.length - 1; k++) {
    const from = points[k]!;
    const to = points[k + 1]!;
    const active = markups.filter((m) => m.start <= from && m.end >= to);
    const link = active.find((m) => m.type === "A");
    const run = {
      text: text.slice(from, to),
      styles: STYLE_ORDER.filter((t) => active.some((m) => m.type === t)).join(","),
      href: link ? linkHref(link) : null,
    };
    const prev = runs.at(-1);
    if (prev && prev.styles === run.styles && prev.href === run.href) prev.text += run.text;
    else runs.push(run);
  }

  let out = "";
  for (let k = 0; k < runs.length; ) {
    // A link can span several differently styled runs.
    const href = runs[k]!.href;
    let inner = "";
    for (; k < runs.length && runs[k]!.href === href; k++) inner += styleRun(runs[k]!.text, runs[k]!.styles);
    out += href ? `[${inner}](${href})` : inner;
  }
  return out;
}

const STYLE_ORDER = ["CODE", "EM", "STRONG"];

function styleRun(text: string, styles: string): string {
  if (!styles) return text;
  // Emphasis markers must hug non-space text ("_word _" isn't italic), so
  // whitespace at the edges stays outside them.
  const [, lead = "", core = "", trail = ""] = text.match(/^(\s*)([\s\S]*?)(\s*)$/) ?? [];
  if (!core) return text;
  const types = styles.split(",");
  // Markers inside backticks would show literally.
  let styled = core;
  for (const type of types.includes("CODE") ? ["CODE"] : types) {
    const [open, close] = MARKERS[type]!;
    styled = `${open}${styled}${close}`;
  }
  return lead + styled + trail;
}

function linkHref(m: Markup): string | null {
  if (m.href) return m.href;
  if (m.anchorType === "USER" && m.userId) return `https://medium.com/u/${m.userId}`;
  return null;
}

/** Shrink a markup so it doesn't start or end on whitespace ("** word**" isn't bold in Markdown, "[word ](…)" looks odd). */
function trimRange(text: string, m: Markup): Markup | null {
  let { start, end } = m;
  start = Math.max(0, Math.min(start, text.length));
  end = Math.max(start, Math.min(end, text.length));
  while (start < end && /\s/.test(text[start]!)) start++;
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  return end > start ? { ...m, start, end } : null;
}
