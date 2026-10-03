// Score headlines with a classifier backend, using the built server's own classifier
// code and your current interests.md. Scores are cached per backend and per version of
// interests.md, so re-running only scores what's new, and editing interests.md starts a
// fresh cache automatically.
//
//   node --env-file=.env tools/classifier/score.mjs [--classifier jev] [--url <endpoint>] [--model <id>] [--all] [--data <dir>] [--interests <file>]
//   node tools/classifier/score.mjs --classifier sampling --base http://localhost:11434/v1 --model <model>
//
// jev uses the server's settings: <PREFIX>_JEV_URL (default OpenRouter), <PREFIX>_JEV_API_KEY
// (default OPENROUTER_API_KEY), <PREFIX>_JEV_MODEL; --url and --model override them.
// On OpenRouter that's about $0.03 per 1,000 headlines. sampling sends the same
// prompt the server sends through MCP sampling, to any OpenAI-compatible chat endpoint
// (Ollama, llama.cpp, vLLM, OpenRouter…), with thinking off. By default only labelled
// headlines are scored; --all scores the whole dataset (useful before label.mjs, so the
// sample can be spread across the rank range).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appendJsonl, arg, dataDir, flag, interestsPath, loadDataset, loadLabels, profileHash, readJsonl, serverModules, SOURCE } from "./lib.mjs";

const kind = arg("classifier", "jev");
const m = await serverModules();
const profileText = readFileSync(interestsPath(), "utf8");
const profile = m.parseProfile(profileText);
const dir = dataDir();
const dataset = loadDataset(dir);
const labels = loadLabels(dir);

let classifier, model;
if (kind === "jev") {
  // Same settings as the server: <PREFIX>_JEV_URL / _JEV_API_KEY / _JEV_MODEL, with --url / --model overrides.
  const jev = m.jevOptionsFromEnv(SOURCE.prefix, { ...process.env, ...(arg("url") ? { [`${SOURCE.prefix}_JEV_URL`]: arg("url") } : {}), ...(arg("model") ? { [`${SOURCE.prefix}_JEV_MODEL`]: arg("model") } : {}) });
  if (jev.error) throw new Error(`${jev.error} (try node --env-file=.env …).`);
  model = jev.opts.model;
  classifier = new m.JevClassifier(jev.opts);
} else if (kind === "sampling") {
  model = arg("model");
  const base = arg("base", "http://localhost:11434/v1").replace(/\/$/, "");
  if (!model) throw new Error("--model is required for sampling.");
  const sample = async ({ systemPrompt, prompt, maxTokens, timeoutMs }) => {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(process.env.SAMPLING_API_KEY ? { Authorization: `Bearer ${process.env.SAMPLING_API_KEY}` } : {}) },
      body: JSON.stringify({ model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0, reasoning_effort: "none" }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()).choices[0].message.content;
  };
  classifier = new m.SamplingClassifier(sample, { requestTimeoutMs: Number(arg("timeout", "120")) * 1000 });
} else {
  throw new Error("--classifier must be jev or sampling.");
}

const file = join(dir, "scores", `${kind}__${model.replace(/[^\w.-]+/g, "_")}__${profileHash(profileText)}.jsonl`);
const done = new Set(readJsonl(file).map((r) => r.id));
const ids = (flag("all") ? [...dataset.keys()] : [...labels.keys()]).filter((id) => dataset.has(id) && !done.has(id));
console.error(`${SOURCE.name} · ${classifier.name}${kind === "sampling" ? ` (${model})` : ""} · interests ${profileHash(profileText)}: ${ids.length} to score, ${done.size} cached`);
if (!ids.length) process.exit(0);

const t0 = Date.now();
const items = ids.map((id) => dataset.get(id));
const r = await classifier.classify(items.map(({ title, subtitle, author, publication }) => ({ title, subtitle, author, publication })), profile);
if (r.unavailable) throw new Error(`classifier unavailable: ${r.unavailable}`);
const rows = [];
r.verdicts.forEach((v, n) => v && rows.push({ id: ids[n], ...(v.rank !== undefined ? { rank: v.rank } : {}), ...(v.skip !== undefined ? { skip: v.skip } : {}) }));
appendJsonl(file, rows);
const secs = (Date.now() - t0) / 1000;
console.error(`scored ${rows.length}/${ids.length} in ${secs.toFixed(1)} s (${((100 * secs) / ids.length).toFixed(1)} s per 100)${r.notes.length ? `; ${r.notes.join("; ")}` : ""}`);
console.error(`→ ${file}`);
