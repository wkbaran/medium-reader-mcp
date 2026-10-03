import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { classifierFromEnv } from "../classifier/index.js";
import { samplingFn } from "../classifier/mcp.js";
import { SamplingRater } from "../classifier/sampling.js";
import { digestKeep, digestRankFloor, digestSkipThreshold, digestStyle, digestTimezone } from "../config.js";
import type { ClientProvider } from "../server.js";
import { errorText, run, text } from "../tool-util.js";
import { BEGIN_DEFAULTS, digestBegin } from "./collect.js";
import { digestFinish, digestStatus, markReported } from "./finish.js";

/** Accept a JSON string where an array is expected; weaker models send arrays that way. */
function lenient<T extends z.ZodType>(schema: T) {
  return z.preprocess((v) => {
    if (typeof v !== "string") return v;
    const s = v.trim();
    if (!s) return [];
    try {
      return JSON.parse(s);
    } catch {
      return s.split(/[\s,]+/).filter(Boolean);
    }
  }, schema);
}

const refList = (what: string) =>
  lenient(z.array(z.string()))
    .default([])
    .describe(`${what} Refs as listed by digest_begin (F3, T1, Y12), post ids or URLs.`);

const pick = z.object({
  ref: z.string().describe("Ref from digest_begin (F3, T1, Y12), post id or URL."),
  gist: z.string().default("").describe("One line: the post's actual point (≤280 characters)."),
});

const localOnly = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

/** Rating tool, always available: it only needs the client to support sampling. */
export function registerRateHeadings(server: McpServer): void {
  server.registerTool(
    "rate_headings",
    {
      title: "Rate headlines",
      description:
        "Rate post headlines against conditions you define (for example \"clickbait\" or \"about databases\"), using the MCP client's own model through sampling. " +
        "Returns, per item and condition, a confidence percentage and a short reason. Needs a client that supports MCP sampling.",
      inputSchema: {
        items: lenient(z.array(z.object({ title: z.string().min(1), subtitle: z.string().optional() })).min(1).max(200)),
        conditions: lenient(
          z
            .array(
              z.object({
                name: z.string().regex(/^[A-Za-z][\w-]{0,30}$/, "letters, digits, _ or -"),
                definition: z.string().min(1).describe("How to decide it, in plain words."),
              }),
            )
            .min(1)
            .max(5),
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ items, conditions }) =>
      run(async () => {
        const sample = samplingFn(server);
        if (!sample) return errorText("This MCP client doesn't support sampling, so there's no model to rate with.");
        const result = await new SamplingRater(sample).rate(items, conditions, { deadline: Date.now() + 170_000 });
        if (result.unavailable) return text(`Rater unavailable: ${result.unavailable}. Nothing was rated.`);
        const lines = items.map((it, n) => {
          const r = result.ratings[n];
          const verdicts = r
            ? conditions.map((c) => (r[c.name] ? `${c.name} ${Math.round(r[c.name]!.confidence * 100)}%${r[c.name]!.reason ? ` (${r[c.name]!.reason})` : ""}` : `${c.name} ?`)).join(" · ")
            : "unrated";
          return `${n + 1}. ${verdicts} | ${it.title}`;
        });
        return text([`Rated ${items.length} against: ${conditions.map((c) => c.name).join(", ")}`, ...lines, ...result.notes.map((x) => `Note: ${x}`)].join("\n"));
      }),
  );
}

export function registerDigestTools(server: McpServer, provider: ClientProvider, dir: string): void {
  server.registerTool(
    "digest_begin",
    {
      title: "Start a digest run",
      description:
        "Step 1 of the daily digest. Collects posts new since the last digest (Following, Medium's top picks, For you), drops ones already reported, " +
        "has the headline classifier rank them and drop confident skips, and returns a plain-text work list with refs (F1, T1, Y1). Saves nothing but a run file; call digest_finish to commit. Call it once, with no arguments.",
      inputSchema: {
        since: z.string().optional().describe('Override the start point: ISO time or "48h". Default: last_run from the state file.'),
        following_max: z.number().int().min(1).max(500).default(BEGIN_DEFAULTS.following_max),
        top_picks: z.number().int().min(0).max(25).default(BEGIN_DEFAULTS.top_picks),
        for_you_end: z.number().int().min(25).max(250).default(BEGIN_DEFAULTS.for_you_end),
        for_you_min: z.number().int().min(0).max(100).default(BEGIN_DEFAULTS.for_you_min),
        for_you_extend_to: z.number().int().min(25).max(250).default(BEGIN_DEFAULTS.for_you_extend_to),
        history: z.number().int().min(0).max(90).default(BEGIN_DEFAULTS.history),
        max_chars: z.number().int().min(10_000).max(45_000).default(BEGIN_DEFAULTS.max_chars),
      },
      annotations: { ...localOnly, idempotentHint: false, openWorldHint: true },
    },
    (args) =>
      run(async () => {
        const client = await provider.get();
        const { classifier, warning } = classifierFromEnv("MEDIUM_READER", samplingFn(server));
        const tz = digestTimezone();
        const { view } = await digestBegin(args, {
          client,
          dir,
          classifier,
          rankFloor: digestRankFloor(),
          tz: warning ? { ...tz, warning: [tz.warning, warning].filter(Boolean).join(" ") } : tz,
          style: digestStyle(),
          threshold: digestSkipThreshold(),
        });
        return text(view);
      }),
  );

  server.registerTool(
    "digest_finish",
    {
      title: "Finish a digest run",
      description:
        "Step 2 of the daily digest. Give your picks by ref; the server checks them against the run, writes the final message, and saves state (every Following post " +
        "plus every post you named). Safe to repeat: a second call for the same run changes nothing. Reply with exactly the text after the ===== DIGEST line.",
      inputSchema: {
        run_id: z.string().optional().describe("Default: the latest run."),
        starred: lenient(
          z
            .array(
              z.object({
                ref: z.string(),
                gist: z.string().default("").describe("1–2 sentences: the argument or findings (≤400 characters)."),
                why: z.string().default("").describe("Why it's worth reading in full (≤250 characters)."),
              }),
            )
            .max(20),
        )
          .default([])
          .describe("⭐ Read in full: usually 3–6, at most 8. Not repeated in their sections."),
        following: lenient(z.array(pick)).default([]).describe("Other Following posts that were read (F refs)."),
        top_picks: lenient(z.array(pick)).default([]).describe("Other top picks that were read (T refs)."),
        for_you: lenient(z.array(pick)).default([]).describe("Other For you posts that were read (Y refs)."),
        preview_only: refList("Posts whose Access line said preview-only."),
        unreadable: refList("Posts that couldn't be read. They're listed under ⚠ and never retried."),
        extra_skipped: refList("Clickbait the rater missed; counted in the 🗑 line and left out of Also new."),
        dry_run: z.boolean().default(false).describe("Render and check without saving anything."),
      },
      annotations: { ...localOnly, idempotentHint: true },
    },
    (args) => run(async () => text(await digestFinish(dir, args, { keep: digestKeep() }))),
  );

  server.registerTool(
    "digest_status",
    {
      title: "Digest status",
      description: "Read-only: the digest state (last_run, how many ids), recent runs and whether each was committed. For checking on or debugging the digest.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      run(async () =>
        text(
          await digestStatus(dir, {
            tz: digestTimezone().tz,
            style: digestStyle(),
            keep: digestKeep(),
            threshold: digestSkipThreshold(),
            classifier: classifierFromEnv("MEDIUM_READER", samplingFn(server)).classifier.name,
            rankFloor: digestRankFloor(),
          }),
        ),
      ),
  );

  server.registerTool(
    "mark_reported",
    {
      title: "Mark posts as reported",
      description:
        "Repair tool: add posts to the digest's reported list so they aren't shown again, and optionally move last_run forward. Only use when asked to fix the digest state.",
      inputSchema: {
        ids: lenient(z.array(z.string()).min(1).max(500)).describe("Post ids, URLs, or refs from the latest run."),
        last_run: z.string().optional().describe('ISO time or "now". last_run never moves backwards.'),
      },
      annotations: { ...localOnly, idempotentHint: true },
    },
    (args) =>
      run(async () => {
        const r = await markReported(dir, args, { keep: digestKeep() });
        return r.ok ? text(r.text) : errorText(r.text);
      }),
  );
}

