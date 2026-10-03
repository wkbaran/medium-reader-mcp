// Draft a proposed interests.md from your own activity, without an agent: gathers the same
// evidence as the interests_evidence tool, asks a chat model to write the file, and saves it
// as interests.proposed.md next to interests.md (which is never touched).
//
//   node --env-file=.env tools/classifier/propose.mjs --model <model> [--base https://openrouter.ai/api/v1] [--labels train] [--out <file>]
//
// --base is any OpenAI-compatible endpoint (OpenRouter by default, using OPENROUTER_API_KEY;
// or e.g. http://localhost:11434/v1 for Ollama). --labels train drafts from half your labels
// so the other half can test the result: score.mjs --interests <proposal>, then
// analyze.mjs --test-half.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { arg, digestDir, SOURCE } from "./lib.mjs";
import { evidenceText } from "./source.mjs";

const model = arg("model");
if (!model) throw new Error("--model is required (e.g. anthropic/claude-sonnet-5.5 on OpenRouter, or a local model name).");
const base = arg("base", "https://openrouter.ai/api/v1").replace(/\/$/, "");
const key = process.env.PROPOSE_API_KEY || (base.includes("openrouter.ai") ? process.env.OPENROUTER_API_KEY : undefined);
const dir = digestDir();
const out = arg("out", dir ? join(dir, "interests.proposed.md") : "interests.proposed.md");
const labels = arg("labels", "all");

const evidence = await evidenceText({ digestDir: dir, labels, history: Number(arg("history", "120")), listItems: Number(arg("list-items", "100")) });
console.error(`${SOURCE.name}: ${evidence.length} characters of evidence (labels: ${labels}); asking ${model}…`);
const res = await fetch(`${base}/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
  body: JSON.stringify({
    model,
    temperature: 0.2,
    messages: [
      { role: "system", content: "You write interests.md files for a reader's news digest. Follow the drafting rules in the evidence exactly. Reply with the file, then the Changes and why list; nothing else." },
      { role: "user", content: evidence },
    ],
  }),
  signal: AbortSignal.timeout(Number(arg("timeout", "300")) * 1000),
});
if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
const reply = (await res.json()).choices[0].message.content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

const { tidyProposal, proposalSummary } = await import(new URL("../../dist/classifier/proposal.js", import.meta.url).href);
const tidy = tidyProposal(reply);
if (!tidy.ok) {
  console.log(reply);
  throw new Error(tidy.error);
}
writeFileSync(out, tidy.text);
const changes = reply.slice(reply.search(/^\s*(#+\s*|\*\*)?changes and why/im)).trim();
const { readFileSync, existsSync } = await import("node:fs");
const current = dir && existsSync(join(dir, "interests.md")) ? readFileSync(join(dir, "interests.md"), "utf8") : "";
console.log(`Saved ${out}.\n\n${proposalSummary(current, tidy.text)}${changes.match(/^\s*(#+\s*|\*\*)?changes and why/i) ? `\n\n${changes}` : ""}`);
