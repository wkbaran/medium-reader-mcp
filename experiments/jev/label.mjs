// Hand-label a sample of headlines for threshold tuning. Resumable; writes data/labels.jsonl.
// Scores and past picks are hidden on purpose so they don't bias you.
//
//   node label.mjs            label the sample (created on first run as data/sample.json)
//   node label.mjs --size 160 size of the sample when it's first created
//
// Keys: 1 skip (slop / never want it)   2 meh (fine, wouldn't open)
//       3 read (would open)              4 must (would be annoyed to miss)
//       u undo last   q quit
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { emitKeypressEvents } from "node:readline";

const data = (f) => new URL(`./data/${f}`, import.meta.url);
const LABELS = { 1: "skip", 2: "meh", 3: "read", 4: "must" };

if (!existsSync(data("sample.json"))) {
  const size = Number(process.argv[process.argv.indexOf("--size") + 1]) || 160;
  writeFileSync(data("sample.json"), JSON.stringify(makeSample(size), null, 1));
}
const sample = JSON.parse(readFileSync(data("sample.json"), "utf8"));
const items = new Map(JSON.parse(readFileSync(data("dataset.json"), "utf8")).map((it) => [it.id, it]));
const labelled = new Map();
if (existsSync(data("labels.jsonl")))
  for (const l of readFileSync(data("labels.jsonl"), "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(l);
    r.label ? labelled.set(r.id, r.label) : labelled.delete(r.id);
  }

/**
 * Stratified so every region of the score range is covered, not just the easy ends:
 * all of Sonnet's "read in full" picks and the user's own reads, then equal draws from
 * five bands of Jev's skip probability (A, title+subtitle), then the most important
 * not-picked items by E. Shuffled with a fixed seed.
 */
function makeSample(size) {
  const ds = JSON.parse(readFileSync(data("dataset.json"), "utf8"));
  const skip = new Map(), imp = new Map();
  for (const l of readFileSync(data("answers.v1.jsonl"), "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(l);
    if (r.variant !== "ts") continue;
    if (r.shape === "r1") skip.set(r.id, r.answers.skip.noul);
    if (r.shape === "r2") imp.set(r.id, r.answers.importance.score);
  }
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const picked = new Set();
  const take = (arr, n) => { for (const it of arr) { if (n <= 0) break; if (!picked.has(it.id)) { picked.add(it.id); n--; } } };
  take(ds.filter((it) => it.sonnet === "read_in_full" || it.user_read), 40);
  const bands = [[0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1.01]];
  const perBand = Math.floor((size - picked.size - 15) / bands.length);
  for (const [lo, hi] of bands) take(shuffle(ds.filter((it) => skip.get(it.id) >= lo && skip.get(it.id) < hi)), perBand);
  take(ds.filter((it) => it.sonnet === "not_picked").sort((a, b) => imp.get(b.id) - imp.get(a.id)), size - picked.size);
  return shuffle([...picked]);
}

const todo = () => sample.filter((id) => !labelled.has(id));
const history = [];
function show() {
  const left = todo();
  if (!left.length) { console.log(`\nAll ${sample.length} labelled. Run: node analyze.mjs --gold`); process.exit(0); }
  const it = items.get(left[0]);
  console.clear();
  console.log(`${sample.length - left.length}/${sample.length} labelled\n`);
  console.log(`\x1b[1m${it.title}\x1b[0m`);
  if (it.subtitle) console.log(`\x1b[2m${it.subtitle}\x1b[0m`);
  console.log(`\n${it.author ?? ""}${it.publication ? " · " + it.publication : ""}${it.readingMinutes ? ` · ${it.readingMinutes} min` : ""}`);
  console.log(`\n[1] skip  [2] meh  [3] read  [4] must    [u] undo  [q] quit`);
}

emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
process.stdin.on("keypress", (str, key) => {
  if (key.name === "q" || (key.ctrl && key.name === "c")) process.exit(0);
  if (str === "u" && history.length) {
    const id = history.pop();
    labelled.delete(id);
    appendFileSync(data("labels.jsonl"), JSON.stringify({ id, label: null }) + "\n");
  } else if (LABELS[str]) {
    const id = todo()[0];
    labelled.set(id, LABELS[str]);
    history.push(id);
    appendFileSync(data("labels.jsonl"), JSON.stringify({ id, label: LABELS[str], at: new Date().toISOString() }) + "\n");
  }
  show();
});
show();
