// How well does each scored classifier (and each version of interests.md) match your labels?
// Prints ranking quality, sweeps the skip threshold and rank floor, recommends settings, and
// lists the headlines where the classifier and you disagree most — the ones to fix in
// interests.md. No API or model calls.
//
//   node tools/classifier/analyze.mjs [--data <dir>] [--interests <file>] [--profile <file>] [--max-read-loss 0.05] [--test-half]
//
// Settings and disagreements are shown for the current interests.md, or for --profile <file>
// (e.g. interests.proposed.md). Every scored version appears in the ranking table.
//
// --test-half scores only the labels a proposal wasn't drafted from (interests_evidence with
// labels: "train" shows the other half), so proposals are compared on unseen labels.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { arg, auc, dataDir, flag, interestsPath, loadDataset, loadLabels, ndcg, profileHash, readJsonl, SOURCE, wanted } from "./lib.mjs";

const dir = dataDir();
const dataset = loadDataset(dir);
const labels = loadLabels(dir);
const maxReadLoss = Number(arg("max-read-loss", "0.05"));
let current;
const names = new Map(); // profile hash → file name, for interests*.md next to the current file
try {
  const path = interestsPath();
  current = profileHash(readFileSync(path, "utf8"));
  const folder = dirname(path);
  for (const f of readdirSync(folder).filter((f) => /^interests.*\.md$/.test(f))) names.set(profileHash(readFileSync(join(folder, f), "utf8")), f);
} catch {
  current = undefined;
}
const profileName = (h) => `${h}${names.has(h) ? ` ${names.get(h)}` : ""}${h === current ? " ✓" : ""}`;

const count = (l) => [...labels.values()].filter((x) => x === l).length;
const n = { skip: count("skip"), meh: count("meh"), read: count("read"), must: count("must") };
console.log(`# ${SOURCE.name} classifier vs your labels\n`);
console.log(`${flag("test-half") ? "Test half only. " : ""}${labels.size} labels: ${n.skip} skip, ${n.meh} meh, ${n.read} read, ${n.must} must. Data: ${dir}`);
if (labels.size < 100 || n.must < 10 || n.skip < 10) console.log(`\n> Few labels: results will be noisy. Aim for 150+ with at least 10 each of skip and must (node tools/classifier/label.mjs --add 50).`);

const files = existsSync(join(dir, "scores")) ? readdirSync(join(dir, "scores")).filter((f) => f.endsWith(".jsonl")) : [];
const runs = files
  .map((f) => {
    const [kind, model, hash] = f.replace(/\.jsonl$/, "").split("__");
    const scores = new Map(readJsonl(join(dir, "scores", f)).map((r) => [r.id, r]));
    return { f, kind, model, hash, scores };
  })
  .filter((r) => [...labels.keys()].some((id) => r.scores.has(id)));
if (!labels.size) {
  console.log("\nNo labels yet. Run: node tools/classifier/label.mjs (in a terminal)");
  process.exit(0);
}
if (!runs.length) {
  console.log("\nNo scores for labelled headlines yet. Run: node --env-file=.env tools/classifier/score.mjs");
  process.exit(0);
}

/** Higher = more wanted. Backends that don't rank are ordered by 1 − skip. */
const order = (s) => s.rank ?? (s.skip !== undefined ? 1 - s.skip : 0.5);
const pct = (x) => (Number.isNaN(x) ? "n/a" : x.toFixed(1));

console.log(`\n## Ranking quality\n\nHigher is better. "AUC wanted": how often a read/must headline outranks a skip/meh one (50 = coin flip). NDCG@20: how close the top 20 is to the ideal order. Profile = hash of interests.md${current ? ` (current: ${current})` : ""}.\n`);
console.log("| backend | model | profile | labelled & scored | AUC wanted | AUC not-slop | NDCG@20 | top 10 wanted | slop in bottom 30 |");
console.log("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const r of runs) {
  const ids = [...labels.keys()].filter((id) => r.scores.has(id));
  const scored = ids.map((id) => [id, order(r.scores.get(id))]);
  const ranked = [...scored].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const bottom = ranked.slice(-30);
  console.log(
    `| ${r.kind}${r.kind === "sampling" ? " (no rank; 1 − skip)" : ""} | ${r.model} | ${profileName(r.hash)} | ${ids.length} | ${pct(auc(scored.map(([id, s]) => [s, wanted(labels.get(id))])))} | ${pct(auc(scored.map(([id, s]) => [s, labels.get(id) !== "skip"])))} | ${pct(ndcg(ranked.map((id) => labels.get(id)), ids.map((id) => labels.get(id)), 20))} | ${Math.round((100 * ranked.slice(0, 10).filter((id) => wanted(labels.get(id))).length) / Math.min(10, ranked.length))}% | ${bottom.filter((id) => labels.get(id) === "skip").length} of ${ids.filter((id) => labels.get(id) === "skip").length} |`,
  );
}

// Settings and disagreements: for the current profile's runs (or all, if interests.md isn't found).
// --profile <file> shows them for another version instead, e.g. interests.proposed.md.
const focus = arg("profile") ? profileHash(readFileSync(arg("profile"), "utf8")) : current;
for (const r of runs.filter((r) => !focus || r.hash === focus)) {
  const ids = [...labels.keys()].filter((id) => r.scores.has(id));
  const L = (id) => labels.get(id);
  const nRead = ids.filter((id) => L(id) === "read").length;
  const tally = (sel) => ({ n: sel.length, skip: sel.filter((id) => L(id) === "skip").length, meh: sel.filter((id) => L(id) === "meh").length, read: sel.filter((id) => L(id) === "read").length, must: sel.filter((id) => L(id) === "must").length });
  const ok = (t) => t.must === 0 && t.read <= maxReadLoss * nRead;
  const row = (label, t) => `| ${label} | ${t.n} | ${t.skip} | ${t.meh} | ${t.read} | ${t.must} |`;
  console.log(`\n## ${r.kind} · ${r.model} · profile ${profileName(r.hash)}`);

  let threshold;
  if (ids.some((id) => r.scores.get(id).skip !== undefined)) {
    console.log(`\n### Skip threshold (${SOURCE.prefix}_DIGEST_SKIP_THRESHOLD): headlines dropped at each value\n`);
    console.log("| threshold | dropped | skip | meh | read lost | must lost |\n| ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const t of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) {
      const d = tally(ids.filter((id) => (r.scores.get(id).skip ?? 0) >= t));
      console.log(row(t, d));
      if (threshold === undefined && ok(d) && d.n > 0) threshold = t;
    }
    console.log(
      threshold !== undefined
        ? `\nRecommended: ${SOURCE.prefix}_DIGEST_SKIP_THRESHOLD=${threshold} (the lowest value that drops no must and at most ${Math.round(maxReadLoss * 100)}% of read).`
        : `\nNo threshold drops anything without losing a must or more than ${Math.round(maxReadLoss * 100)}% of read: rely on ranking, or set the threshold to 1 to turn skipping off.`,
    );
  }

  if (ids.some((id) => r.scores.get(id).rank !== undefined)) {
    const t = threshold ?? 1.01;
    const kept = ids.filter((id) => (r.scores.get(id).skip ?? 0) < t);
    let floor = 0;
    console.log(`\n### Rank floor (${SOURCE.prefix}_DIGEST_RANK_FLOOR): headlines collapsed to one line at each value${threshold !== undefined ? `, after skipping at ${threshold}` : ""}\n`);
    console.log("| floor | collapsed | skip | meh | read | must |\n| ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const f of [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4]) {
      const d = tally(kept.filter((id) => (r.scores.get(id).rank ?? 1) < f));
      console.log(row(f, d));
      if (ok(d)) floor = f;
    }
    console.log(
      floor
        ? `\nRecommended: ${SOURCE.prefix}_DIGEST_RANK_FLOOR=${floor} (the highest value that collapses no must and at most ${Math.round(maxReadLoss * 100)}% of read). Collapsed posts stay valid refs and still appear under "Also new".`
        : `\nNo floor collapses anything without hiding a must: leave ${SOURCE.prefix}_DIGEST_RANK_FLOOR unset. Sorting alone still puts them last.`,
    );
  }

  const show = (title, list) => {
    if (!list.length) return;
    console.log(`\n### ${title}\n`);
    for (const id of list) {
      const s = r.scores.get(id), d = dataset.get(id);
      const nums = [s.rank !== undefined ? `rank ${Math.round(s.rank * 100)}` : "", s.skip !== undefined ? `skip ${Math.round(s.skip * 100)}` : ""].filter(Boolean).join(", ");
      console.log(`- **${L(id)}** (${nums}) ${d?.title ?? id}${d?.subtitle ? ` — _${d.subtitle.slice(0, 80)}_` : ""}`);
    }
  };
  const byOrder = [...ids].sort((a, b) => order(r.scores.get(a)) - order(r.scores.get(b)));
  console.log(`\n### Where you and the classifier disagree most\n\nUse these to edit interests.md: add the topic you wanted, or narrow the Skip pattern that caught it. Then score again (a changed interests.md gets its own cache) and compare the rows above.`);
  show("Wanted, but ranked lowest", byOrder.filter((id) => wanted(L(id))).slice(0, 10));
  show("Labelled skip, but ranked highest", byOrder.filter((id) => L(id) === "skip").reverse().slice(0, 10));
}
