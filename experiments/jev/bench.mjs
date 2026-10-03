// Rater benchmark: score the labelled sample with one backend and save the result to data/bench/.
// Compare backends with `node bench-report.mjs`. The labels, sample and interests profile are shared
// with the Jev trials, so every backend is judged on the same 160 headlines.
//
//   node bench.mjs jev      [--profile v2]                       reads Jev answers cached by run.mjs (PROFILE=v2 run.mjs --sample --shape r2 --variant ts)
//   node bench.mjs sampling --model qwen3.6-27b-ctx131k [--base http://localhost:11435/v1] [--batch 40] [--profile v2]
//                           the production SamplingRater (dist/classifier/sampling.js) against any OpenAI-compatible chat endpoint
//   node bench.mjs embed    --model nomic-embed-text:v1.5 [--base …] [--prefix "classification: "] [--profile v2]
//                           embedding similarity: closest Interest bullet minus closest Skip bullet
//
// Ollama on dtop.home isn't reachable from WSL; tunnel through the Hermes host:
//   ssh -f -N -L 11435:dtop.home:11434 core@192.168.50.207
// Add a backend by writing a function that returns { ratings: { [id]: { score, want?, skip? } }, notes } (higher score = more wanted).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { SamplingRater, skipCondition } from "../../dist/classifier/sampling.js";
import { parseInterests } from "../../dist/digest/interests.js";

const data = (f) => new URL(`./data/${f}`, import.meta.url);
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const backend = process.argv[2];
const profile = arg("profile", "v2");
const base = arg("base", "http://localhost:11435/v1").replace(/\/$/, "");
const model = arg("model", backend === "jev" ? "typesafe/jev-1.13" : undefined);
if (!model) throw new Error("--model is required");

const ids = JSON.parse(readFileSync(data("sample.json"), "utf8"));
const byId = new Map(JSON.parse(readFileSync(data("dataset.json"), "utf8")).map((it) => [it.id, it]));
const items = ids.map((id) => byId.get(id));
const md = readFileSync(data(`interests.${profile}.md`), "utf8");
const interests = parseInterests(md);
const bullets = (s) => (s || "").split("\n").filter((l) => l.trim().startsWith("- ")).map((l) => l.trim().slice(2));

/** The ranking condition, phrased like Jev's importance question so the backends answer the same thing. */
const wantCondition = {
  name: "want",
  definition:
    "The reader would want to read this post: it fits what they like and promises real substance. " +
    "Low for off-topic posts and for anything matching the skip patterns.\n" +
    `What the reader likes:\n${interests.interests}\nSkip patterns:\n${interests.skip}`,
};

async function loadedModels() {
  try {
    const r = await fetch(base.replace(/\/v1$/, "") + "/api/ps");
    return (await r.json()).models.map((m) => `${m.name} (${(m.size_vram / 1e9).toFixed(1)} GB)`);
  } catch {
    return undefined;
  }
}

const backends = {
  async jev() {
    const ratings = {}, ms = [];
    let cost = 0;
    for (const l of readFileSync(data(`answers.${profile}.jsonl`), "utf8").split("\n").filter(Boolean)) {
      const r = JSON.parse(l);
      if (r.shape !== "r2" || r.variant !== "ts" || !ids.includes(r.id)) continue;
      ratings[r.id] = { score: r.answers.importance.score / 3, want: r.answers.importance.score / 3, skip: r.answers.skip_ctx.noul };
      ms.push(r.ms);
      cost += r.usage?.cost ?? 0;
    }
    ms.sort((a, b) => a - b);
    // run.mjs sends 8 requests at a time, so wall time ≈ total request time / 8.
    return { ratings, costUsd: cost, wallS: ms.reduce((a, b) => a + b, 0) / 8 / 1000, notes: [`median request ${ms[ms.length >> 1]} ms; wall time estimated for 8 parallel requests`] };
  },

  async sampling() {
    const sample = async ({ systemPrompt, prompt, maxTokens, timeoutMs }) => {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(process.env.BENCH_API_KEY ? { Authorization: `Bearer ${process.env.BENCH_API_KEY}` } : {}) },
        body: JSON.stringify({ model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], max_tokens: maxTokens, reasoning_effort: "none", temperature: 0 }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return (await res.json()).choices[0].message.content;
    };
    const rater = new SamplingRater(sample, { batchSize: Number(arg("batch", "40")), requestTimeoutMs: 120_000 });
    const rateItems = items.map((it) => ({ title: it.title, subtitle: it.subtitle || undefined, author: it.author || undefined, publication: it.publication || undefined }));
    const res = await rater.rate(rateItems, [skipCondition(interests), wantCondition]);
    if (res.unavailable) throw new Error(`rater unavailable: ${res.unavailable}`);
    const ratings = {};
    items.forEach((it, i) => {
      const r = res.ratings[i];
      if (r) ratings[it.id] = { score: r.want.confidence, want: r.want.confidence, skip: r.skip.confidence };
    });
    return { ratings, costUsd: 0, notes: res.notes };
  },

  async embed() {
    const prefix = arg("prefix", model.includes("nomic") ? "classification: " : "");
    const embed = async (texts) => {
      const res = await fetch(`${base}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: texts.map((t) => prefix + t) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return (await res.json()).data.map((d) => d.embedding);
    };
    const cos = (a, b) => {
      let d = 0, na = 0, nb = 0;
      for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
      return d / Math.sqrt(na * nb);
    };
    const like = await embed(bullets(interests.interests));
    const skip = await embed(bullets(interests.skip));
    const ratings = {};
    for (let i = 0; i < items.length; i += 32) {
      const chunk = items.slice(i, i + 32);
      const vecs = await embed(chunk.map((it) => [it.title, it.subtitle].filter(Boolean).join(". ")));
      chunk.forEach((it, j) => {
        const w = Math.max(...like.map((v) => cos(vecs[j], v)));
        const s = Math.max(...skip.map((v) => cos(vecs[j], v)));
        ratings[it.id] = { score: w - s, want: w, skip: s };
      });
    }
    return { ratings, costUsd: 0, notes: prefix ? [`prefix "${prefix}"`] : [] };
  },
};

if (!backends[backend]) throw new Error(`backend must be one of: ${Object.keys(backends).join(", ")}`);
const before = backend === "jev" ? undefined : await loadedModels();
const t0 = Date.now();
const out = await backends[backend]();
const wallS = out.wallS ?? (Date.now() - t0) / 1000;
const after = backend === "jev" ? undefined : await loadedModels();
const rated = Object.keys(out.ratings).length;

mkdirSync(data("bench"), { recursive: true });
const file = data(`bench/${backend}__${model.replace(/[^\w.-]+/g, "_")}__${profile}.json`);
writeFileSync(
  file,
  JSON.stringify({ backend, model, profile, base: backend === "jev" ? "openrouter" : base, date: new Date().toISOString(), items: items.length, rated, wallS, costUsd: out.costUsd, notes: out.notes, gpuBefore: before, gpuAfter: after, ratings: out.ratings }, null, 1),
);
console.error(`${backend} ${model}: rated ${rated}/${items.length} in ${wallS.toFixed(1)} s${out.costUsd ? `, $${out.costUsd.toFixed(4)}` : ""}${out.notes?.length ? `; ${out.notes.join("; ")}` : ""}`);
if (after) console.error(`loaded before: ${before?.join(", ") || "none"}; after: ${after.join(", ") || "none"}`);
