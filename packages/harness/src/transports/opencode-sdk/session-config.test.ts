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
