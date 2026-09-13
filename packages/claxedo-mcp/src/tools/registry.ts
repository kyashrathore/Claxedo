import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { ShapeOutput } from "@modelcontextprotocol/sdk/server/zod-compat.js"
import { assertToolAccess, McpAccessDenied, toolListed, type McpToolAccess, type McpToolContext } from "../context"
import { mcpToolRefusal, toCallToolResult, type McpToolResult, type McpToolShape } from "../mcp-tool"

export type McpToolDefinition<Shape extends McpToolShape> = Readonly<{
  description: string
  inputSchema: Shape
  access: McpToolAccess
  /** The session a write addresses, read from the arguments before the handler runs. */
  sessionIdOf?: (args: ShapeOutput<Shape>) => string | undefined
  /**
   * For a write whose arguments do not name its session — a question is
   * addressed by request id, and which session raised it is known only once
   * the runtime has been read — the audit waits for the handler, which names
   * the session through the `addressed` callback it is given.
   */
  sessionIdFromHandler?: true
}>

export type McpToolHandler<Shape extends McpToolShape> = (
  args: ShapeOutput<Shape>,
  ctx: McpToolContext,
  /** Names the session this call turned out to address; only passed under `sessionIdFromHandler`. */
  addressed?: (sessionId: string) => void,
) => Promise<McpToolResult>

export type ToolRegistry = {
  readonly ctx: McpToolContext
  tool<Shape extends McpToolShape>(name: string, definition: McpToolDefinition<Shape>, handler: McpToolHandler<Shape>): void
  /** Every name registered, listed or not, with its access; the pinned-list tests read this. */
  readonly declared: ReadonlyMap<string, McpToolAccess>
  readonly listed: readonly string[]
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
      if (!toolListed(ctx.credential, definition.access, ctx.client.tasks?.operations)) return
      listed.push(name)
      // `ToolCallback<Shape>` is a conditional type over the shape; it resolves
      // only for a concrete shape, so a callback written once for every shape
      // cannot be checked against it; the SDK rejects even a direct assertion,
      // so this is the one conversion through unknown in the package.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- see above: `ToolCallback<Shape>` resolves only for a concrete shape.
      const callback = (async (args: ShapeOutput<Shape>) => {
          try {
            assertToolAccess(ctx.credential, name, definition.access, ctx.client.tasks?.operations)
            if (definition.access.destructive && ctx.elicit) {
              const answer = await ctx.elicit({
                mode: "form",
                message: `Confirm ${name}?`,
                requestedSchema: { type: "object", properties: {} },
              })
              if (answer.action !== "accept") return toCallToolResult(mcpToolRefusal(`${name} was not confirmed`))
            }
            const record = (sessionId: string | undefined) => ctx.audit({
              tool: name,
              credential: ctx.credential,
              args: args as Record<string, unknown>,
              ...(sessionId ? { sessionId } : {}),
            })
            if (!definition.access.write) return toCallToolResult(await handler(args, ctx))
            if (!definition.sessionIdFromHandler) {
              await record(definition.sessionIdOf?.(args))
              return toCallToolResult(await handler(args, ctx))
            }
            let addressed: string | undefined
            try {
              return toCallToolResult(await handler(args, ctx, (sessionId) => { addressed = sessionId }))
            } finally {
              await record(addressed)
            }
          } catch (error) {
            if (error instanceof McpAccessDenied) return toCallToolResult(mcpToolRefusal(error.message))
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
