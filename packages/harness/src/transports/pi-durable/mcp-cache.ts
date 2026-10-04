import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { defineDoc, type JsonObject } from "@earendil-works/pi-durable"
import type { PiSessionRuntime } from "./placement"

export type McpListedTool = { name: string; description?: string; inputSchema: JsonObject }
export type McpToolLists = Record<string, McpListedTool[]>

const McpToolsDoc = defineDoc<{ key: string; servers: McpToolLists }>({
  kind: "claxedo.mcp-tools",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ key: "", servers: {} }),
  checkpointWhen: () => true,
})

const detached = (servers: McpToolLists): McpToolLists => JSON.parse(JSON.stringify(servers))

export function cachedMcpTools(runtime: PiSessionRuntime, key: string): Promise<McpToolLists> {
  return runtime.harness.commit(async (tx) => {
    const doc = await tx.doc(McpToolsDoc, runtime.conversation.id)
    return doc.key === key ? detached(doc.servers) : {}
  }, BACKGROUND_CONTEXT)
}

export async function recordMcpTools(runtime: PiSessionRuntime, key: string, lists: McpToolLists): Promise<void> {
  await runtime.harness.commit(async (tx) => {
    const doc = await tx.doc(McpToolsDoc, runtime.conversation.id)
    doc.key = key
    doc.servers = lists
  }, BACKGROUND_CONTEXT)
}
