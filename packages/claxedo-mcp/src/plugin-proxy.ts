import { z } from "zod"
import { decodeApiError } from "@claxedo/helpers/api-error"
import { pluginToolDeclarationSchema, type PluginToolDeclaration } from "@claxedo/plugin-api/release"
import {
  appPluginToolGroupId,
  PLUGIN_TOOL_AGENT_HEADER,
  PLUGIN_TOOL_RESULT_MAX_BYTES,
  PLUGIN_TOOLS_ROUTE,
  pluginToolCallPath,
  type PluginToolAgent,
  type PluginToolsListing,
} from "@claxedo/plugin-api/tools"
import type { ClaxedoFetch, ClaxedoMcpClient } from "./client/contract"
import type { McpCredential, McpToolContext, McpToolService } from "./context"
import { mcpToolRefusal, type McpToolResult, type McpToolShape } from "./mcp-tool"
import { declaredToolAccess } from "./tools/inventory"
import type { McpToolGroup } from "./tool-group"

/**
 * The service grant through which a caller reaches its app plugins' tools:
 * the control plane's tools listing and each plugin's `/_tools/<name>`, as
 * that caller. A mount whose client carries no such grant serves no plugin tools.
 */
export const APP_PLUGIN_TOOLS_SERVICE = { id: "app-plugin-tools", label: "app plugin tools" } as const satisfies McpToolService

const listingSchema = z.array(
  z.object({ pluginId: z.string().min(1), label: z.string().min(1), tools: z.array(pluginToolDeclarationSchema) }),
)

const resultSchema = z
  .object({
    content: z.array(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("text"), text: z.string() }).strict(),
        z.object({ type: z.literal("image"), mimeType: z.enum(["image/png", "image/jpeg"]), data: z.string() }).strict(),
      ]),
    ),
    isError: z.boolean().optional(),
  })
  .strict()

function inputShape(declaration: PluginToolDeclaration): McpToolShape | undefined {
  const schema = z.fromJSONSchema(declaration.inputSchema)
  return schema instanceof z.ZodObject ? schema.shape : undefined
}

function agentOf(ctx: McpToolContext): PluginToolAgent {
  const { credential } = ctx
  const ownerDriven = ctx.client.ownerDriven?.()
  return credential.kind === "runtime"
    ? { ...(credential.sessionId ? { sessionId: credential.sessionId } : {}), ...(ownerDriven === undefined ? {} : { ownerDriven }) }
    : {}
}

/** The body, or undefined once it holds more than `limit` bytes; the rest is not read. */
async function responseTextWithin(response: Response, limit: number): Promise<string | undefined> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      return undefined
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** A backend's answer to one tool call, as the agent receives it: a tool result of at most 256 KiB, or a refusal saying why not. */
export async function pluginToolResult(tool: string, response: Response): Promise<McpToolResult> {
  const text = await responseTextWithin(response, PLUGIN_TOOL_RESULT_MAX_BYTES)
  if (text === undefined) return mcpToolRefusal(`${tool} answered more than ${PLUGIN_TOOL_RESULT_MAX_BYTES / 1024} KiB`)
  const body = jsonOf(text)
  if (!response.ok) return mcpToolRefusal(decodeApiError(response.status, body)?.message || `${tool} failed`)
  const result = resultSchema.safeParse(body)
  return result.success ? result.data : mcpToolRefusal(`${tool} answered something that is not a tool result`)
}

function proxyGroup(listing: PluginToolsListing): McpToolGroup {
  const tools = listing.tools.flatMap((declaration) => {
    const shape = inputShape(declaration)
    return shape ? [{ declaration, shape }] : []
  })
  return {
    id: appPluginToolGroupId(listing.pluginId),
    reach: { service: APP_PLUGIN_TOOLS_SERVICE.id },
    register(registry) {
      for (const { declaration, shape } of tools) {
        const write = declaration.access === "write"
        registry.tool(
          declaration.name,
          {
            description: declaration.description,
            inputSchema: shape,
            access: declaredToolAccess({ audiences: ["runtime", "user"], write, scope: write ? "act" : "read", service: APP_PLUGIN_TOOLS_SERVICE }),
          },
          async (args, ctx) => {
            const grant = ctx.client.services[APP_PLUGIN_TOOLS_SERVICE.id]
            if (!grant) return mcpToolRefusal(`${declaration.name} needs the ${APP_PLUGIN_TOOLS_SERVICE.label}, which this session was not granted`)
            const response = await grant.fetch(pluginToolCallPath(listing.pluginId, declaration.name), {
              method: "POST",
              headers: { "content-type": "application/json", [PLUGIN_TOOL_AGENT_HEADER]: JSON.stringify(agentOf(ctx)) },
              body: JSON.stringify({ arguments: args }),
            })
            return await pluginToolResult(declaration.name, response)
          },
        )
      }
    },
  }
}

/** What the caller's app plugins serve, as the control plane lists it through the caller's grant. */
export async function readPluginToolListings(fetch: ClaxedoFetch): Promise<readonly PluginToolsListing[]> {
  const response = await fetch(PLUGIN_TOOLS_ROUTE)
  if (!response.ok) throw new Error(`The app plugin tools listing answered ${response.status}`)
  return listingSchema.parse(await response.json())
}

/**
 * A mount's `pluginToolGroups`: one proxy group per plugin the client's app
 * plugin tools grant lists, none when the client carries no such grant. A
 * listing that cannot be read leaves the session with the mount's own groups.
 */
export async function appPluginToolGroups(_credential: McpCredential, client: ClaxedoMcpClient): Promise<readonly McpToolGroup[]> {
  const grant = client.services[APP_PLUGIN_TOOLS_SERVICE.id]
  if (!grant) return []
  try {
    return (await readPluginToolListings(grant.fetch)).map(proxyGroup)
  } catch (error) {
    console.warn("[claxedo-mcp] app plugin tools are not served to this session", error)
    return []
  }
}
