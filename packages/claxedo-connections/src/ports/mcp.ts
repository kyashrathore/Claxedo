import type { BrokeredPort } from "./serving.js"

/**
 * `mcp` — tools served by a Model Context Protocol server.
 *
 * Brokered: the tool schemas belong to the server, and the kit neither authors
 * nor validates them. A retained MCP server therefore contributes an OAuth
 * grant against its authorization server and no operations at all — which is
 * why the port has to be declarable rather than inferred from an action map.
 */
export type McpPort = BrokeredPort<"mcp">

export const mcpPort: McpPort = { capability: "mcp" }
