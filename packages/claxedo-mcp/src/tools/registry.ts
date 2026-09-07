import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { ShapeOutput } from "@modelcontextprotocol/sdk/server/zod-compat.js"
import { assertToolAccess, McpAccessDenied, toolListed, type McpToolAccess, type McpToolContext } from "../context"
import { toCallToolResult, type McpToolResult, type McpToolShape } from "../mcp-tool"

export type McpToolDefinition<Shape extends McpToolShape> = Readonly<{
  description: string
  inputSchema: Shape
  access: McpToolAccess
  /** The session a write addresses, for the audit line. */
  sessionIdOf?: (args: ShapeOutput<Shape>) => string | undefined
}>

export type McpToolHandler<Shape extends McpToolShape> = (
  args: ShapeOutput<Shape>,
  ctx: McpToolContext,
) => Promise<McpToolResult>

export type ToolRegistry = {
  readonly ctx: McpToolContext
  tool<Shape extends McpToolShape>(name: string, definition: McpToolDefinition<Shape>, handler: McpToolHandler<Shape>): void
  /** Every name registered, listed or not, with its access; the pinned-list tests read this. */
  readonly declared: ReadonlyMap<string, McpToolAccess>
  readonly listed: readonly string[]
}

export function denied(message: string): McpToolResult {
  return { content: [{ type: "text", text: message }], isError: true }
}

/**
 * One server per connection, built for one credential: a tool the credential
 * may not use is not registered, so `tools/list` is already the audience's
 * list, and the handler re-checks anyway because a client can call what it
 * was not shown. Destructive tools ask the host through elicitation when the
 * client declared it; a client that auto-accepts its own elicitation is bound
 * by scope, not by this prompt.
 */
export function createToolRegistry(server: McpServer, ctx: McpToolContext): ToolRegistry {
  const declared = new Map<string, McpToolAccess>()
  const listed: string[] = []
  return {
    ctx,
    declared,
    listed,
    tool<Shape extends McpToolShape>(name: string, definition: McpToolDefinition<Shape>, handler: McpToolHandler<Shape>) {
      declared.set(name, definition.access)
      if (!toolListed(ctx.credential, definition.access)) return
      listed.push(name)
      // `ToolCallback<Shape>` is a conditional type over the shape; it resolves
      // only for a concrete shape, so a callback written once for every shape
      // cannot be checked against it; the SDK rejects even a direct assertion,
      // so this is the one conversion through unknown in the package.
      const callback = (async (args: ShapeOutput<Shape>) => {
          try {
            assertToolAccess(ctx.credential, name, definition.access)
            if (definition.access.destructive && ctx.elicit) {
              const answer = await ctx.elicit({
                mode: "form",
                message: `Confirm ${name}?`,
                requestedSchema: { type: "object", properties: {} },
              })
              if (answer.action !== "accept") return toCallToolResult(denied(`${name} was not confirmed`))
            }
            if (definition.access.write) {
              const sessionId = definition.sessionIdOf?.(args)
              await ctx.audit({
                tool: name,
                credential: ctx.credential,
                args: args as Record<string, unknown>,
                ...(sessionId ? { sessionId } : {}),
              })
            }
            return toCallToolResult(await handler(args, ctx))
          } catch (error) {
            if (error instanceof McpAccessDenied) return toCallToolResult(denied(error.message))
            throw error
          }
        }) as unknown as ToolCallback<Shape>
      server.registerTool(
        name,
        {
          description: definition.description,
          inputSchema: definition.inputSchema,
          annotations: {
            readOnlyHint: !definition.access.write,
            destructiveHint: definition.access.destructive === true,
          },
        },
        callback,
      )
    },
  }
}
