// Hand-label headlines: the ground truth every classifier setting is tuned against.
// Shows one headline at a time with no scores, so they can't bias you. Resumable.
//
//   node tools/classifier/label.mjs [--add 100] [--data <dir>]
//
// The first run picks a sample of 150 (or --add N); later runs with --add pick N more
// unlabelled headlines. If the dataset has been scored (score.mjs), the sample is spread
// evenly across the classifier's rank range so thresholds get tested where they matter;
// otherwise it's random. Posts the digest starred are always included.
//
// Keys: 1 skip (slop, never want it)   2 meh (fine, wouldn't open)
//       3 read (would open)             4 must (would be annoyed to miss)
//       u undo   q quit
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { appendJsonl, arg, dataDir, loadDataset, loadLabels, readJsonl, writeJson } from "./lib.mjs";

const LABELS = { 1: "skip", 2: "meh", 3: "read", 4: "must" };
const dir = dataDir();
const dataset = loadDataset(dir);
const labels = loadLabels(dir);
const sampleFile = join(dir, "sample.json");
let sample = existsSync(sampleFile) ? JSON.parse(readFileSync(sampleFile, "utf8")) : [];

const add = Number(arg("add", sample.length ? "0" : "150"));
if (add > 0) {
  sample = [...sample, ...pick(add, new Set([...sample, ...labels.keys()]))];
  writeJson(sampleFile, sample);
}
if (!sample.length) {
  console.log(`Nothing to label: the dataset in ${dir} is empty. Run collect.mjs first.`);
  process.exit(0);
}

/** n unlabelled ids: starred first, then evenly across rank bands (or random). */
function pick(n, exclude) {
  let seed = sample.length + 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const pool = [...dataset.values()].filter((r) => !exclude.has(r.id));
  const out = pool.filter((r) => r.picked === "starred").slice(0, Math.ceil(n / 5)).map((r) => r.id);
  const rest = pool.filter((r) => !out.includes(r.id));
  const ranks = latestRanks();
  if (ranks.size) {
    const bands = 5, per = Math.ceil((n - out.length) / bands);
    for (let b = 0; b < bands; b++) {
      const inBand = rest.filter((r) => ranks.has(r.id) && Math.min(bands - 1, Math.floor(ranks.get(r.id) * bands)) === b);
      out.push(...shuffle(inBand).slice(0, per).map((r) => r.id));
    }
  }
  out.push(...shuffle(rest.filter((r) => !out.includes(r.id))).map((r) => r.id));
  return shuffle(out.slice(0, n));
}

/** Ranks from the most recent ranking scores file, if any. */
function latestRanks() {
  const files = readdirSync(join(dir, "scores")).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, "scores", f));
  for (const f of files.sort().reverse()) {
    const rows = readJsonl(f).filter((r) => r.rank !== undefined);
    if (rows.length) return new Map(rows.map((r) => [r.id, r.rank]));
  }
  return new Map();
}

const todo = () => sample.filter((id) => !labels.has(id) && dataset.has(id));
const history = [];
function show() {
  const left = todo();
  if (!left.length) {
    console.log(`\nAll ${sample.length} labelled (${labels.size} labels in total). Next: node tools/classifier/score.mjs, then analyze.mjs.`);
    process.exit(0);
  }
  const it = dataset.get(left[0]);
  console.clear();
  console.log(`${sample.length - left.length}/${sample.length} labelled\n`);
  console.log(`\x1b[1m${it.title}\x1b[0m`);
  if (it.subtitle) console.log(`\x1b[2m${it.subtitle}\x1b[0m`);
  console.log(`\n${it.author ?? ""}${it.publication ? " · " + it.publication : ""}`);
  console.log(`\n[1] skip  [2] meh  [3] read  [4] must    [u] undo  [q] quit`);
}

if (!process.stdin.isTTY) {
  console.log(`${todo().length} of ${sample.length} sampled headlines still need labels. Run this in a terminal to label them.`);
  process.exit(0);
}
emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
process.stdin.on("keypress", (str, key) => {
  if (key.name === "q" || (key.ctrl && key.name === "c")) process.exit(0);
  if (str === "u" && history.length) {
    const id = history.pop();
    labels.delete(id);
    appendJsonl(join(dir, "labels.jsonl"), [{ id, label: null }]);
  } else if (LABELS[str]) {
    const id = todo()[0];
    labels.set(id, LABELS[str]);
    history.push(id);
    appendJsonl(join(dir, "labels.jsonl"), [{ id, label: LABELS[str], at: new Date().toISOString() }]);
  }
  show();
});
show();
