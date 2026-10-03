/** The bridge from an MCP server to the `sampling` backend: the connected client's model. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SampleFn } from "./sampling.js";

/** A SampleFn backed by the connected client's sampling support, or null when it has none. */
export function samplingFn(server: McpServer): SampleFn | null {
  if (!server.server.getClientCapabilities()?.sampling) return null;
  return async ({ systemPrompt, prompt, maxTokens, timeoutMs }) => {
    // No modelPreferences: Hermes uses a hint's name as the model id, which would
    // bypass the model configured for this server.
    const result = await server.server.createMessage(
      { messages: [{ role: "user", content: { type: "text", text: prompt } }], systemPrompt, maxTokens, temperature: 0, includeContext: "none" },
      { timeout: timeoutMs },
    );
    const blocks = Array.isArray(result.content) ? result.content : [result.content];
    return blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");
  };
}
