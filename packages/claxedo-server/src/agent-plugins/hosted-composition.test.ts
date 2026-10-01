import { expect, test, vi } from "vitest"
import { createHostedAgentPluginsComposition } from "./hosted-composition"
import type { AgentPluginMcpRuntimeState } from "./mcp/runtime-preparation"

type Input = Parameters<typeof createHostedAgentPluginsComposition>[0]
const preparation = { state: { kind: "agent-plugins-mcp-runtime", plan: { revision: 1, mcpServers: [], execution: { selectionHash: "a".repeat(64), selections: [] } } } satisfies AgentPluginMcpRuntimeState }

function composition(pushRuntime?: Input["pushRuntime"]) {
  return createHostedAgentPluginsComposition({
    env: { CLAXEDO_PUBLIC_URL: "https://control.test", CLAXEDO_AGENT_PLUGINS: {
      get: async () => { throw new Error("Unexpected artifact read") },
      put: async () => { throw new Error("Unexpected artifact write") },
    } },
    plane: { services: { authority: {}, sandbox: {} }, orgCredentials: () => { throw new Error("Unexpected credential read") } } as unknown as Input["plane"],
    database: { prepare: () => { throw new Error("Unexpected settings bypass") } } as unknown as Input["database"],
    authentication: {} as Input["authentication"],
    tasksGrant: async () => { throw new Error("Unexpected Tasks grant") },
    ownerGrant: async () => { throw new Error("Unexpected owner grant") },
    passes: { record: async () => {}, revoked: async () => false, revoke: async () => 0, outstanding: async () => [] },
    pushRuntime,
  })
}

test("Task selected capabilities use settings delivery and propagate its failure", async () => {
  const push = vi.fn(async () => {})
  const feature = composition(push)
  await feature.selectedCapabilities.apply({ workspaceId: "ws", preparation })
  expect(push).toHaveBeenCalledWith({ workspaceId: "ws" }, preparation)
  push.mockRejectedValueOnce(new Error("Settings refused"))
  await expect(feature.selectedCapabilities.apply({ workspaceId: "ws", preparation })).rejects.toThrow("Settings refused")
})

test("Task selected capabilities refuse a composition without settings delivery", async () => {
  await expect(composition().selectedCapabilities.apply({ workspaceId: "ws", preparation })).rejects.toThrow("Selected capabilities require hosted settings delivery")
})
