// Score the cached Jev answers against labels. No API calls.
//
//   node analyze.mjs            silver labels (Sonnet's past picks + reading history)
//   node analyze.mjs --gold     hand labels from data/labels.jsonl (see label.mjs)
//   node analyze.mjs --examples print the worst disagreements for each signal
import { readFileSync, existsSync } from "node:fs";
import { ANSWERS_FILE, PROFILE, INTERESTS, SKIPS } from "./questions.mjs";

const data = (f) => new URL(`./data/${f}`, import.meta.url);
const items = new Map(JSON.parse(readFileSync(data("dataset.json"), "utf8")).map((it) => [it.id, it]));
const ans = new Map(); // `${shape}|${variant}|${id}` -> answers
for (const l of readFileSync(ANSWERS_FILE, "utf8").split("\n").filter(Boolean)) {
  const r = JSON.parse(l);
  ans.set(`${r.shape}|${r.variant}|${r.id}`, r.answers);
}
const gold = process.argv.includes("--gold");
const showExamples = process.argv.includes("--examples");

// ---- labels ---------------------------------------------------------------
// Each label set: id -> true (positive: wanted) / false (negative). Undefined = not in this set.
const labelSets = {};
if (gold) {
  const g = new Map();
  for (const l of readFileSync(data("labels.jsonl"), "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(l);
    r.label ? g.set(r.id, r.label) : g.delete(r.id); // skip | meh | read | must; null = undone
  }
  labelSets["gold: slop (skip) vs rest"] = map(g, (l) => (l === "skip" ? false : true));
  labelSets["gold: want (read|must) vs rest"] = map(g, (l) => l === "read" || l === "must");
  labelSets["gold: must vs rest"] = map(g, (l) => l === "must");
} else {
  const all = [...items.values()];
  labelSets["silver: picked (any section or read) vs not picked"] = new Map(all.map((it) => [it.id, it.sonnet !== "not_picked" || it.user_read]));
  labelSets["silver: read in full vs not picked"] = new Map(
    all.filter((it) => it.sonnet !== "listed").map((it) => [it.id, it.sonnet === "read_in_full" || it.user_read]),
  );
}
function map(m, f) {
  return new Map([...m].map(([k, v]) => [k, f(v)]));
}

// ---- signals --------------------------------------------------------------
// Every signal is "higher = more wanted", so skip-style probabilities are negated.
// Keys come from the cached answers, so older profiles with other key names still work.
const anyR1 = [...ans].find(([k]) => k.startsWith("r1|"))[1];
const PATS = Object.keys(anyR1).filter((k) => k.startsWith("pat_")).map((k) => k.slice(4));
const INTEREST_TOPICS = Object.keys(anyR1.topic.probabilities).filter((k) => !["other_tech", "other", "non_tech"].includes(k));
console.log(`# Profile ${PROFILE}\n\nInterests: ${INTERESTS.map((s, i) => `i${i + 1} ${s.split(":")[0]}`).join("; ")}\nSkip patterns: ${SKIPS.map((s, i) => `pat_${i + 1} ${s.slice(0, 40)}`).join("; ")}`);
const signals = {};
for (const v of ["t", "ts", "tss"]) {
  const r1 = (id) => ans.get(`r1|${v}|${id}`);
  const r2 = (id) => ans.get(`r2|${v}|${id}`);
  signals[`A  skip noul (${v})`] = (id) => r1(id) && -r1(id).skip.noul;
  signals[`B  max skip-pattern noul (${v})`] = (id) => r1(id) && -Math.max(...PATS.map((p) => r1(id)[`pat_${p}`].noul));
  signals[`C  substance score (${v})`] = (id) => r1(id) && r1(id).substance.score;
  signals[`D  P(topic in interests) (${v})`] = (id) => r1(id) && INTEREST_TOPICS.reduce((s, k) => s + r1(id).topic.probabilities[k], 0);
  signals[`E  importance score (${v})`] = (id) => r2(id) && r2(id).importance.score;
  signals[`A' skip noul, reader in state (${v})`] = (id) => r2(id) && -r2(id).skip_ctx.noul;
  signals[`C+D substance × P(interest) (${v})`] = (id) => r1(id) && r1(id).substance.score * signals[`D  P(topic in interests) (${v})`](id);
}
signals["Q  Qwen sampling rater skip (prod, 123 items)"] = (id) => (items.get(id)?.qwen_skip == null ? undefined : -items.get(id).qwen_skip);

// ---- metrics --------------------------------------------------------------
function auc(pairs) {
  // pairs: [score, label]; Mann–Whitney with ties counted half
  const pos = pairs.filter((p) => p[1]).map((p) => p[0]);
  const neg = pairs.filter((p) => !p[1]).map((p) => p[0]);
  if (!pos.length || !neg.length) return NaN;
  let s = 0;
  for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0;
  return s / (pos.length * neg.length);
}
const pct = (x) => (Number.isNaN(x) ? "  n/a" : (100 * x).toFixed(1).padStart(5));

for (const [name, labels] of Object.entries(labelSets)) {
  const nPos = [...labels.values()].filter(Boolean).length;
  console.log(`\n## ${name}  (${nPos} positive / ${labels.size - nPos} negative)\n`);
  console.log("| signal | n | AUC |");
  console.log("| --- | ---: | ---: |");
  for (const [s, f] of Object.entries(signals)) {
    const pairs = [...labels].map(([id, y]) => [f(id), y]).filter((p) => p[0] !== undefined);
    console.log(`| ${s} | ${pairs.length} | ${pct(auc(pairs))} |`);
  }
}

// Threshold sweep for the drop-in skip gate: what it would drop, and what it would wrongly drop.
for (const sig of ["A  skip noul (ts)", "B  max skip-pattern noul (ts)", "A' skip noul, reader in state (ts)", "B  max skip-pattern noul (tss)", "A' skip noul, reader in state (tss)"]) {
  const sweepName = gold ? "gold: want (read|must) vs rest" : Object.keys(labelSets)[0];
  const labels = labelSets[sweepName];
  console.log(`\n## Skip-gate sweep: ${sig} vs ${sweepName}\n`);
  console.log("| threshold | dropped | of all | positives wrongly dropped | of positives |");
  console.log("| ---: | ---: | ---: | ---: | ---: |");
  for (const t of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
    let dropped = 0, bad = 0, nPos = 0;
    for (const [id, y] of labels) {
      const p = -signals[sig](id);
      if (Number.isNaN(p)) continue;
      if (y) nPos++;
      if (p >= t) { dropped++; if (y) bad++; }
    }
    console.log(`| ${t} | ${dropped} | ${pct(dropped / labels.size)}% | ${bad} | ${pct(bad / nPos)}% |`);
  }
}

// Agreement with the production Qwen rater (threshold 0.7) on the items it rated.
const q = [...items.values()].filter((it) => it.qwen_skip != null);
for (const sig of ["A  skip noul (ts)", "A' skip noul, reader in state (ts)"]) {
  let both = 0, onlyQ = 0, onlyJ = 0, neither = 0;
  for (const it of q) {
    const qs = it.qwen_skip >= 0.7, js = -signals[sig](it.id) >= 0.5;
    qs && js ? both++ : qs ? onlyQ++ : js ? onlyJ++ : neither++;
  }
  console.log(`\nQwen≥0.7 vs ${sig}≥0.5 on ${q.length} items: both skip ${both}, Qwen only ${onlyQ}, Jev only ${onlyJ}, neither ${neither}`);
}

if (showExamples) {
  const fmt = (it, v) => `  ${v.toFixed(2)}  [${it.sonnet}${it.user_read ? ",read" : ""}] ${it.title}`;
  for (const [s, k, dir] of [
    ["A  skip noul (ts)", "positives Jev would skip (highest skip prob)", 1],
    ["E  importance score (ts)", "not-picked items Jev rates most important", -1],
    ["E  importance score (ts)", "picked items Jev rates least important", 1],
  ]) {
    console.log(`\n### ${s}: ${k}`);
    const wantPos = k.startsWith("positives") || k.startsWith("picked");
    const rows = [...items.values()]
      .filter((it) => (it.sonnet !== "not_picked" || it.user_read) === wantPos)
      .map((it) => [it, signals[s](it.id)])
      .filter((r) => r[1] !== undefined)
      .sort((a, b) => dir * (a[1] - b[1]))
      .slice(0, 12);
    for (const [it, v] of rows) console.log(fmt(it, s.startsWith("A") ? -v : v));
  }
}
