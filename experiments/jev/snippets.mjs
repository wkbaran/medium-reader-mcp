// Fetch the opening ~80 words of each labelled post (Phase 3 snippet arm). Cached in data/snippets.json.
// Uses the local medium-reader login and the built client in ../../dist (run `npm run build` first).
//
//   node snippets.mjs [--words 80]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { ClientProvider } from "../../dist/server.js";
import { markdownToText, paragraphsToMarkdown } from "../../dist/format.js";

const data = (f) => new URL(`./data/${f}`, import.meta.url);
const words = Number(process.argv[process.argv.indexOf("--words") + 1]) || 80;
const ids = JSON.parse(readFileSync(data("sample.json"), "utf8"));
const items = new Map(JSON.parse(readFileSync(data("dataset.json"), "utf8")).map((it) => [it.id, it]));
const out = existsSync(data("snippets.json")) ? JSON.parse(readFileSync(data("snippets.json"), "utf8")) : {};

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const client = await new ClientProvider().get();
let n = 0;
for (const id of ids) {
  if (out[id]?.text) continue;
  try {
    const post = await client.post(id);
    const md = paragraphsToMarkdown(post.paragraphs, { title: post.summary.title });
    // Drop leading lines that only repeat the title or subtitle (Medium bodies usually start with them).
    const sub = norm(items.get(id)?.subtitle), title = norm(post.summary.title);
    const lines = markdownToText(md).split("\n").map((l) => l.trim()).filter((l) => l && !/^image:/i.test(l));
    while (lines.length && [title, sub].some((t) => t && (norm(lines[0]) === t || t.startsWith(norm(lines[0]))))) lines.shift();
    const all = lines.join(" ").replace(/\[image:[^\]]*\]\s*/gi, "").split(/\s+/);
    out[id] = { text: all.slice(0, words).join(" ") + (all.length > words ? " …" : ""), totalWords: all.length };
  } catch (e) {
    out[id] = { error: String(e.message || e).slice(0, 200) };
  }
  if (++n % 20 === 0) { writeFileSync(data("snippets.json"), JSON.stringify(out, null, 1)); console.error(`${n} fetched`); }
  await new Promise((r) => setTimeout(r, 400)); // be gentle with medium.com
}
writeFileSync(data("snippets.json"), JSON.stringify(out, null, 1));
const errs = Object.values(out).filter((v) => v.error);
console.error(`done: ${Object.keys(out).length - errs.length} snippets, ${errs.length} errors${errs.length ? ` (e.g. ${errs[0].error})` : ""}`);
