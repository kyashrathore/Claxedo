import type { z } from "zod"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

export type McpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: "image/png" | "image/jpeg"; data: string }

export type McpToolResult = Readonly<{
  content: readonly Readonly<McpContentBlock>[]
  isError?: boolean
}>

/**
 * A tool that can only answer in text. Documents tools are text-only by
 * construction and read `content[0].text` back in their CLI and tests, so they
 * keep the narrower promise rather than re-checking a block they never emit.
 */
export type McpTextToolResult = Readonly<{
  content: readonly Readonly<{ type: "text"; text: string }>[]
  isError?: boolean
}>

export type McpToolConfig<Shape> = Readonly<{
  description: string
  inputSchema: Shape
  _meta?: Record<string, unknown>
}>

/** The per-call context a handler is allowed to see. `requestId` scopes tool-call ids. */
export type McpToolExtra = { requestId: string | number }

export type McpToolShape = Record<string, z.ZodTypeAny>

export type RegisterMcpTool = <Shape extends McpToolShape>(
  name: string,
  config: McpToolConfig<Shape>,
  handler: (args: z.infer<z.ZodObject<Shape>>, extra: McpToolExtra) => Promise<McpToolResult>,
) => void

/**
 * The one place a tool result crosses into the SDK.
 *
 * `CallToolResult` is inferred from a Zod schema, so it is mutable and open;
 * ours is readonly and closed, which is the right shape for handlers that build
 * a result and hand it away. Copying at the boundary lets each side keep its
 * own description instead of one pretending to be the other.
 */
export function toCallToolResult(result: McpToolResult): CallToolResult {
  return {
    content: result.content.map((block) => ({ ...block })),
    ...(result.isError === undefined ? {} : { isError: result.isError }),
  }
}
