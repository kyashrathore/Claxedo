import { expect, test } from "bun:test"
import type { DraftLaunch, HarnessSession } from "../../contract"
import type { Entry } from "./entry"
import { openCodeConfigOperations } from "./session-config"
import { WorkspaceScope } from "./scope"

const scope = WorkspaceScope.authorize({ workspaceID: "preview", directory: "/tmp" })
const draft: DraftLaunch = {
  workspaceId: "preview", directory: "/tmp", locality: "local", owner: { kind: "machine-owner" },
  model: { providerID: "proof", modelID: "current" },
  config: { harness: { id: "opencode", access: "native" }, model: { providerID: "proof", modelID: "old" } },
  credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "one" },
  projection: { generation: "one", mcpServers: [], pluginRoots: [], notApplied: [] },
}

function preview() {
  return openCodeConfigOperations({
    entry: () => ({ start: draft }) as Entry,
    targetScope: () => scope,
    models: async () => ["old", "current"].map((id) => ({ providerID: "proof", id, name: id, cost: [] })),
    switchModel: async () => {},
  })
}

test("draft previews use the resolved draft model", async () => {
  expect((await preview().options({ draft }, "probe")).resolvedModel).toEqual({ id: "proof/current", name: "current" })
})

test("a preview without a current model does not resurrect the model saved at attachment", async () => {
  expect((await preview().options({ session: {} as HarnessSession }, "probe")).resolvedModel).toBeUndefined()
})

test("a live change without a model is refused rather than dropped", async () => {
  const switched: unknown[] = []
  const config = openCodeConfigOperations({
    entry: () => ({ start: draft, scope, upstream: "upstream" }) as unknown as Entry,
    targetScope: () => scope,
    models: async () => [{ providerID: "proof", id: "current", name: "current", cost: [], variants: ["high"] }],
    switchModel: async (_scope, _upstream, model) => { switched.push(model) },
  })
  await expect(config.setModelSettings!({} as HarnessSession, { effort: "high" })).rejects.toThrow("OpenCode requires a model")
  await config.setModelSettings!({} as HarnessSession, { model: { providerID: "proof", modelID: "current" }, effort: null })
  expect(switched).toEqual([{ providerID: "proof", modelID: "current" }])
})
