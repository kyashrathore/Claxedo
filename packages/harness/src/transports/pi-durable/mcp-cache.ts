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

export function cachedMcpTools(runtime: PiSessionRuntime, key: string): Promise<McpToolLists> {
  return runtime.harness.commit(async (tx) => {
    const doc = await tx.doc(McpToolsDoc, runtime.conversation.id)
    return doc.key === key ? JSON.parse(JSON.stringify(doc.servers)) as McpToolLists : {}
  }, BACKGROUND_CONTEXT)
}

export async function recordMcpTools(runtime: PiSessionRuntime, key: string, lists: McpToolLists): Promise<void> {
  await runtime.harness.commit(async (tx) => {
    const doc = await tx.doc(McpToolsDoc, runtime.conversation.id)
    doc.key = key
    doc.servers = lists
  }, BACKGROUND_CONTEXT)
}
