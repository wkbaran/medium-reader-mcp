// Compare every saved benchmark run (data/bench/*.json) on the hand labels. No API or model calls.
//
//   node bench-report.mjs [--profile v2]
//
// Ranking is what matters: a post ranked low is effectively filtered. Labels are graded
// skip 0 · meh 1 · read 2 · must 3.
import { readFileSync, readdirSync } from "node:fs";

const data = (f) => new URL(`./data/${f}`, import.meta.url);
const profile = process.argv.includes("--profile") ? process.argv[process.argv.indexOf("--profile") + 1] : "v2";
const GAIN = { skip: 0, meh: 1, read: 2, must: 3 };
const labels = new Map();
for (const l of readFileSync(data("labels.jsonl"), "utf8").split("\n").filter(Boolean)) {
  const r = JSON.parse(l);
  r.label ? labels.set(r.id, r.label) : labels.delete(r.id);
}

function auc(scored, isPos) {
  const pos = scored.filter(([id]) => isPos(labels.get(id))).map((x) => x[1]);
  const neg = scored.filter(([id]) => !isPos(labels.get(id))).map((x) => x[1]);
  let s = 0;
  for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0;
  return (100 * s) / (pos.length * neg.length);
}
function ndcg(ranked, k) {
  const dcg = (gs) => gs.slice(0, k).reduce((s, g, i) => s + (2 ** g - 1) / Math.log2(i + 2), 0);
  const ideal = [...labels.values()].map((l) => GAIN[l]).sort((a, b) => b - a);
  return (100 * dcg(ranked.map((id) => GAIN[labels.get(id)]))) / dcg(ideal);
}
const share = (ids, f) => Math.round((100 * ids.filter((id) => f(labels.get(id))).length) / ids.length);

const runs = readdirSync(data("bench"))
  .filter((f) => f.endsWith(`__${profile}.json`))
  .map((f) => JSON.parse(readFileSync(data(`bench/${f}`), "utf8")));
const nSlop = [...labels.values()].filter((l) => l === "skip").length;

console.log(`Profile ${profile}; ${labels.size} labels (${["skip", "meh", "read", "must"].map((l) => `${[...labels.values()].filter((x) => x === l).length} ${l}`).join(", ")})\n`);
console.log("| backend | model | rated | AUC wanted | AUC not-slop | NDCG@20 | top 10 wanted | top 20 must | slop in bottom 30 | s per 100 | $ per 100 |");
console.log("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const r of runs.sort((a, b) => a.backend.localeCompare(b.backend) || a.model.localeCompare(b.model))) {
  // Unrated items rank in the middle (score 0.5 for 0–1 scores), as they would be neither boosted nor dropped.
  const scored = [...labels.keys()].map((id) => [id, r.ratings[id]?.score ?? 0.5]);
  const ranked = [...scored].sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  const bottom = ranked.slice(-30);
  console.log(
    `| ${r.backend} | ${r.model} | ${r.rated}/${r.items} | ${auc(scored, (l) => l === "read" || l === "must").toFixed(1)} | ${auc(scored, (l) => l !== "skip").toFixed(1)} | ${ndcg(ranked, 20).toFixed(1)} | ${share(ranked.slice(0, 10), (l) => l === "read" || l === "must")}% | ${share(ranked.slice(0, 20), (l) => l === "must")}% | ${bottom.filter((id) => labels.get(id) === "skip").length}/${nSlop} | ${((100 * r.wallS) / r.items).toFixed(1)} | ${r.costUsd ? ((100 * r.costUsd) / r.items).toFixed(4) : "0"} |`,
  );
}
const base = [...labels.keys()];
console.log(`\nBase rates: wanted ${share(base, (l) => l === "read" || l === "must")}%, must ${share(base, (l) => l === "must")}%. A random ranking puts about ${Math.round((30 * nSlop) / labels.size)} slop posts in the bottom 30.`);
for (const r of runs) if (r.gpuAfter) console.log(`- ${r.model}: GPU before [${r.gpuBefore?.join(", ") || "none"}] → after [${r.gpuAfter.join(", ")}]`);
