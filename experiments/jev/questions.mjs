// Trial arms: the state shapes and Jev questions we compare.
// Each request shape is sent once per headline; every question in it is answered
// independently, so bundling only saves resending the state.
import { readFileSync, existsSync } from "node:fs";

/** Which interests file to trial: data/interests.<PROFILE>.md, answers cached in data/answers.<PROFILE>.jsonl. */
export const PROFILE = process.env.PROFILE || "v1";
export const ANSWERS_FILE = new URL(`./data/answers.${PROFILE}.jsonl`, import.meta.url);
const md = readFileSync(new URL(`./data/interests.${PROFILE}.md`, import.meta.url), "utf8");
function sectionBody(name) {
  const m = md.match(new RegExp(`^##\\s+${name}\\s*$([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, "mi"));
  return m ? m[1].split("\n").map((l) => l.trim()).filter(Boolean) : [];
}
const bullets = (name) => sectionBody(name).filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());
export const INTERESTS = bullets("Interests");
export const SKIPS = bullets("Skip");
/** Prose in the Skip section other than the bullets (e.g. "a catchy title alone is not a reason to skip"). */
const SKIP_NOTE = sectionBody("Skip")
  .filter((l) => !l.startsWith("- "))
  .join(" ")
  .replace(/^Titles matching these patterns \(by intent, not exact wording\) are dropped entirely\.\s*/, "");

/** Topic keys: i1..iN for the Interests bullets, plus two catch-alls. Pattern keys: pat_1..pat_N. */
export const TOPICS = {
  ...Object.fromEntries(INTERESTS.map((s, i) => [`i${i + 1}`, s])),
  other_tech: "Other software or technology topics not listed above.",
  other: "Anything else not listed above (career, self-help, culture, politics, personal life).",
};

const snippetsFile = new URL("./data/snippets.json", import.meta.url);
const SNIPPETS = existsSync(snippetsFile) ? JSON.parse(readFileSync(snippetsFile, "utf8")) : {};

const headline = (it, variant) => {
  if (variant === "t") return { title: it.title };
  const h = { title: it.title, subtitle: it.subtitle || "", author: it.author || "", publication: it.publication || "self-published" };
  if (variant === "tss") {
    const s = SNIPPETS[it.id]?.text;
    if (!s) throw new Error(`no snippet for ${it.id} (run snippets.mjs)`);
    h.opening = s;
  }
  return h;
};

/**
 * R1 — reader-agnostic judgments about the headline itself.
 *   A  skip            one Noul over the whole Skip list (drop-in for SamplingRater)
 *   B  pat_<key>       one Noul per Skip bullet (tunable per pattern; says which rule fired)
 *   C  substance       Score: how concrete/substantive the headline promises to be
 *   D  topic           Choice over the Interests list + other_tech / non_tech
 */
export function r1(it, variant) {
  const q = {
    skip: {
      type: "noul",
      instructions: "Does this Medium headline match any of the reader's skip patterns? Judge by intent, not exact wording." + (SKIP_NOTE ? " " + SKIP_NOTE : ""),
      criteria: {
        true: "It matches at least one of: " + SKIPS.map((s) => `(${s})`).join("; "),
        false: "It matches none of those patterns.",
      },
    },
    substance: {
      type: "score",
      instructions: "How much concrete substance does this headline promise?",
      criteria: [
        "Engagement bait or slop: vague promise, outrage, or a hook with no real subject",
        "Generic opinion, roundup, or advice anyone could write",
        "A specific subject, but depth is unclear",
        "Concrete technical or factual substance: named systems, measurements, incidents, or results",
      ],
    },
    topic: {
      type: "choice",
      instructions: "Which topic is this post mainly about?",
      criteria: TOPICS,
    },
  };
  SKIPS.forEach((s, i) => {
    q[`pat_${i + 1}`] = { type: "noul", instructions: `Does this Medium headline fit this pattern: ${s}?` };
  });
  return { state: { headline: headline(it, variant) }, questions: q };
}

/**
 * R2 — reader-specific: the reader's interests and skips go into the state.
 *   E  importance      Score: how much this reader would want it
 *   A' skip_ctx        the skip Noul again, with the reader profile in state
 */
export function r2(it, variant) {
  return {
    state: { reader: { interests: INTERESTS, skips: SKIPS, ...(SKIP_NOTE ? { skip_note: SKIP_NOTE } : {}) }, headline: headline(it, variant) },
    questions: {
      importance: {
        type: "score",
        instructions: "Given the reader's interests and skips, how much would this reader want to read this post?",
        criteria: [
          "Not for this reader: off-topic or matches a skip pattern",
          "Marginal: related area, little reason to open it",
          "Worth a skim",
          "Must read: squarely in the reader's interests with real substance",
        ],
      },
      skip_ctx: {
        type: "noul",
        instructions: "Should this post be dropped because it matches one of the reader's skips?",
      },
    },
  };
}

export const SHAPES = { r1, r2 };
// title only; title + subtitle + author + publication; ts + the post's opening ~80 words (labelled sample only)
export const VARIANTS = ["t", "ts"];
export const ALL_VARIANTS = ["t", "ts", "tss"];
