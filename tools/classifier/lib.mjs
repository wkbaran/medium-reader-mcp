// Shared helpers for the classifier tools (collect, label, score, analyze).
// Source-agnostic: the source-specific bits are in source.mjs.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SOURCE } from "./source.mjs";

export { SOURCE };

export function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}
export const flag = (name) => process.argv.includes(`--${name}`);

/** The digest directory, from --digest-dir or the server's env var. */
export function digestDir() {
  const d = arg("digest-dir", process.env[SOURCE.digestDirEnv]);
  return d ? resolve(d) : undefined;
}

/** Where labels, the dataset and scores live: --data, else <digest dir>/classifier, else ./classifier-data. */
export function dataDir() {
  const d = resolve(arg("data", digestDir() ? join(digestDir(), "classifier") : "classifier-data"));
  mkdirSync(join(d, "scores"), { recursive: true });
  return d;
}

/** interests.md: --interests, else <digest dir>/interests.md. */
export function interestsPath() {
  const p = arg("interests", digestDir() ? join(digestDir(), "interests.md") : undefined);
  if (!p || !existsSync(p)) throw new Error(`No interests.md found${p ? ` at ${p}` : ""}. Pass --interests <file> or set ${SOURCE.digestDirEnv}.`);
  return resolve(p);
}

/** A short hash of the profile text, so scores are cached per version of interests.md. */
export const profileHash = (text) => createHash("sha256").update(text.replace(/\r\n/g, "\n").trim()).digest("hex").slice(0, 8);

export function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
export const appendJsonl = (file, rows) => rows.length && appendFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
export const writeJson = (file, v) => writeFileSync(file, JSON.stringify(v, null, 1) + "\n");

/** Dataset rows by id (dataset.jsonl; later rows win). */
export function loadDataset(dir) {
  return new Map(readJsonl(join(dir, "dataset.jsonl")).map((r) => [r.id, r]));
}

/** Same split as isTrainLabel in src/classifier/evidence.ts: proposals are drafted from the train half. */
export const isTrainLabel = (id) => createHash("sha256").update(id).digest()[0] % 2 === 0;

/** Labels by id (labels.jsonl; a null label undoes). Labels: skip | meh | read | must. --test-half keeps only labels outside the drafting half. */
export function loadLabels(dir) {
  const m = new Map();
  for (const r of readJsonl(join(dir, "labels.jsonl"))) (r.label ? m.set(r.id, r.label) : m.delete(r.id));
  if (flag("test-half")) for (const id of [...m.keys()]) if (isTrainLabel(id)) m.delete(id);
  return m;
}

export const GAIN = { skip: 0, meh: 1, read: 2, must: 3 };
export const wanted = (l) => l === "read" || l === "must";

/** Mann–Whitney AUC, ties half. `pairs` = [score, isPositive]. */
export function auc(pairs) {
  const pos = pairs.filter((p) => p[1]).map((p) => p[0]);
  const neg = pairs.filter((p) => !p[1]).map((p) => p[0]);
  if (!pos.length || !neg.length) return NaN;
  let s = 0;
  for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0;
  return (100 * s) / (pos.length * neg.length);
}

export function ndcg(rankedLabels, allLabels, k) {
  const dcg = (ls) => ls.slice(0, k).reduce((s, l, i) => s + (2 ** GAIN[l] - 1) / Math.log2(i + 2), 0);
  const ideal = dcg([...allLabels].sort((a, b) => GAIN[b] - GAIN[a]));
  return ideal ? (100 * dcg(rankedLabels)) / ideal : NaN;
}

/** Load the built server's classifier modules (the tools score with exactly what the server runs). */
export async function serverModules() {
  const dist = new URL("../../dist/", import.meta.url);
  if (!existsSync(new URL("classifier/index.js", dist))) throw new Error("dist/ is missing: run `npm run build` first.");
  const classifier = await import(new URL("classifier/index.js", dist).href);
  const sampling = await import(new URL("classifier/sampling.js", dist).href);
  return { ...classifier, ...sampling };
}
