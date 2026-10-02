import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AuthError } from "./medium/http.js";

/** Run a tool body, turning a thrown error into an MCP error result. */
export async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: "text", text: err instanceof AuthError ? `Authentication required: ${message}` : `Error: ${message}` }],
    };
  }
}

export function text(t: string): CallToolResult {
  return { content: [{ type: "text", text: t }] };
}

export function errorText(t: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: t }] };
}

export function json(value: unknown): CallToolResult {
  // Compact: pretty-printing added ~20% to large results, and some MCP hosts
  // divert results over ~50k characters to a file the model can't parse.
  return text(JSON.stringify(value));
}

export function parseSince(since: string | undefined, now = Date.now()): Date | undefined {
  if (!since) return undefined;
  const rel = since.trim().match(/^(\d+)\s*([hdw])$/i);
  if (rel) {
    const unit = { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[rel[2]!.toLowerCase() as "h" | "d" | "w"];
    return new Date(now - Number(rel[1]) * unit);
  }
  const t = Date.parse(since);
  if (Number.isNaN(t)) throw new Error(`Couldn't understand since="${since}". Use an ISO date or e.g. "7d".`);
  return new Date(t);
}
