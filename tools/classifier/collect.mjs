// Add the headlines from the digest's run files to the labelling dataset.
// The server keeps only the newest 14 run files, so run this every week or two
// (or after each digest) to build up history. Already-collected posts are skipped.
//
//   node tools/classifier/collect.mjs [--runs <dir>] [--data <dir>]
//
// --runs defaults to <digest dir>/runs. If the digest runs on another machine,
// copy its runs/ directory here first and point --runs at the copy.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { appendJsonl, arg, dataDir, digestDir, loadDataset, SOURCE } from "./lib.mjs";
import { extraRunFiles, headlinesFromRun } from "./source.mjs";

const runsDir = resolve(arg("runs", digestDir() ? join(digestDir(), "runs") : "runs"));
const dir = dataDir();
const have = loadDataset(dir);
const added = [];
let files = 0;
const paths = [
  ...(existsSync(runsDir) ? readdirSync(runsDir).filter((f) => f.endsWith(".json")).sort().map((f) => join(runsDir, f)) : []),
  ...extraRunFiles(digestDir()).filter((f) => existsSync(f)),
];
for (const path of paths) {
  files++;
  for (const h of headlinesFromRun(JSON.parse(readFileSync(path, "utf8")))) {
    if (!h.id || !h.title || have.has(h.id)) continue;
    have.set(h.id, h);
    added.push({ ...h, collected: new Date().toISOString() });
  }
}
appendJsonl(join(dir, "dataset.jsonl"), added);
console.log(`${SOURCE.name}: read ${files} run file${files === 1 ? "" : "s"}; added ${added.length} headlines; dataset now ${have.size} (${join(dir, "dataset.jsonl")}).`);
