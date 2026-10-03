// Send trial requests to Jev and cache every raw answer in data/answers.<PROFILE>.jsonl.
// PROFILE (env, default v1) picks data/interests.<PROFILE>.md.
// Already-answered (shape, variant, id) triples are skipped, so re-running is free.
//
//   node --env-file=../../.env run.mjs [--shape r1,r2] [--variant t,ts,tss] [--sample] [--limit N] [--ids a,b] [--concurrency 8]
//   --sample limits the run to the labelled sample (data/sample.json); the tss variant needs it.
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { SHAPES, VARIANTS, ANSWERS_FILE, PROFILE } from "./questions.mjs";

const MODEL = "typesafe/jev-1.13";
const URL_ = "https://openrouter.ai/api/alpha/decisions";
const ANSWERS = ANSWERS_FILE;

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const shapes = arg("shape", "r1,r2").split(",");
const variants = arg("variant", VARIANTS.join(",")).split(",");
const limit = Number(arg("limit", "0"));
const ids = arg("ids", "")?.split(",").filter(Boolean);
const concurrency = Number(arg("concurrency", "8"));
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error("OPENROUTER_API_KEY not set (run with --env-file=../../.env)");

let items = JSON.parse(readFileSync(new URL("./data/dataset.json", import.meta.url), "utf8"));
if (ids.length) items = items.filter((it) => ids.includes(it.id));
if (process.argv.includes("--sample")) {
  const sample = new Set(JSON.parse(readFileSync(new URL("./data/sample.json", import.meta.url), "utf8")));
  items = items.filter((it) => sample.has(it.id));
}
if (limit) items = items.slice(0, limit);

const done = new Set();
if (existsSync(ANSWERS))
  for (const l of readFileSync(ANSWERS, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(l);
    done.add(`${r.shape}|${r.variant}|${r.id}`);
  }

const jobs = [];
for (const it of items) for (const s of shapes) for (const v of variants) if (!done.has(`${s}|${v}|${it.id}`)) jobs.push({ it, s, v });
console.error(`profile ${PROFILE}: ${jobs.length} requests to send (${done.size} cached)`);

const snippetOk = (id) => {
  try { SHAPES.r1({ id, title: "" }, "tss"); return true; } catch { return false; }
};

let pauseUntil = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(body) {
  for (let attempt = 0; ; attempt++) {
    const wait = pauseUntil - Date.now();
    if (wait > 0) await sleep(wait);
    const res = await fetch(URL_, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, ...body }),
    });
    if (res.ok) return res.json();
    const text = await res.text();
    const retryable = res.status === 429 || res.status >= 500 || (res.status === 402 && text.includes("in_flight_budget"));
    if (!retryable || attempt >= 5) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    const ra = Number(res.headers.get("retry-after"));
    pauseUntil = Date.now() + (ra > 0 ? ra * 1000 : Math.min(30000, 1000 * 2 ** attempt) + Math.random() * 500);
  }
}

let cost = 0, n = 0, failed = 0, tokens = 0;
const queue = [...jobs];
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const { it, s, v } = queue.shift();
      try {
        if (v === "tss" && !snippetOk(it.id)) continue;
        const t0 = Date.now();
        const r = await call(SHAPES[s](it, v));
        cost += r.usage?.cost ?? 0;
        tokens += r.usage?.input_tokens ?? 0;
        appendFileSync(ANSWERS, JSON.stringify({ shape: s, variant: v, id: it.id, ms: Date.now() - t0, model: r.model, answers: r.answers, usage: r.usage }) + "\n");
        if (++n % 100 === 0) console.error(`${n}/${jobs.length}  $${cost.toFixed(4)}`);
      } catch (e) {
        failed++;
        console.error(`${s}/${v}/${it.id}: ${e.message}`);
        if (/HTTP 40[13]/.test(e.message)) { queue.length = 0; }
      }
    }
  }),
);
console.error(`done: ${n} ok, ${failed} failed, ${tokens} input tokens, $${cost.toFixed(5)}` + (n ? ` ($${((cost / n) * 1000).toFixed(4)} per 1,000 requests)` : ""));
