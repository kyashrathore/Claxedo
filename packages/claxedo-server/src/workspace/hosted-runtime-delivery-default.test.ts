import { afterEach, expect, test, vi } from "vitest"
import type { UserAgentConfig } from "@claxedo/server-core/agent-config/config"
import type { ControlPlaneDatabase } from "../test-support/control-plane-migrations"
import { workspaceBackingDatabase } from "../test-support/workspace-backing-database"
import { createHostedRuntimeDelivery } from "./hosted-runtime-delivery"
import { unusedSandboxStart } from "../test-support/inline-sandbox-start"

const configStatus = vi.hoisted(() => vi.fn(async (): Promise<import("@claxedo/workspace-runtime/config").RuntimeConfigApplyStatus> => ({ state: "idle", revision: 0 })))
const configApplied = vi.hoisted(() => vi.fn(async (_snapshot: import("@claxedo/workspace-runtime/config").RuntimeSnapshot) => {}))
vi.mock("@claxedo/workspace-runtime/client", () => ({ createWorkspaceRuntimeClient: vi.fn(() => ({ applyConfig: configApplied, configStatus })) }))
vi.mock("@claxedo/server-core/platform/auth/runtime-access-token", () => ({ mintSupervisorBackplaneToken: vi.fn(async () => ({ supervisorBackplaneToken: "supervisor-token" })) }))

type Input = Parameters<typeof createHostedRuntimeDelivery>[0]

const active: ControlPlaneDatabase[] = []
afterEach(async () => { await Promise.all(active.splice(0).map((instance) => instance.dispose())) })

async function createDelivery(config: UserAgentConfig, backing: "cloud-vm" | "local-worktree" = "cloud-vm") {
  const instance = await workspaceBackingDatabase([{ id: "ws", backing }])
  active.push(instance)
  return createHostedRuntimeDelivery({
      sandboxStart: unusedSandboxStart,
    authority: { resolveWorkspaceOwner: async () => ({ userId: "owner", orgId: "org", projectId: "project" }) } as unknown as Input["authority"],
    database: instance.database,
    services: { sandbox: { sandboxManager: { target: async () => ({ status: "ready", hostId: "host", url: "https://runtime.test" }) } } } as unknown as Input["services"],
    sandboxManager: {} as Input["sandboxManager"],
    workspaceDriver: async () => ({ driver: { metadata: { secretBrokering: "native" } }, key: "operator" }) as Awaited<ReturnType<Input["workspaceDriver"]>>,
    sandboxInput: async () => { throw new Error("this test provisions no sandbox") },
    settings: { read: async () => config, write: async () => {} },
    credentials: () => ({ listCredentials: async () => [], accountSelections: async () => ({}), resolveCredentialSecretById: async () => null }) as unknown as ReturnType<Input["credentials"]>,
    signingEnv: {},
    provisionedRunner: "pi",
  })
}

async function firstPush(config: UserAgentConfig, plugins: import("@claxedo/server-core/agent-config/runtime-snapshot").AgentPluginRuntimeContribution = { harnessLaunch: {}, mcp: {} }, backing?: "cloud-vm" | "local-worktree") {
  const delivery = await createDelivery(config, backing)
  delivery.composeRuntime({ prepareRuntime: delivery.prepareRuntime, pluginRuntime: async () => plugins })
  configApplied.mockClear()
  await delivery.provisionRuntime({ workspaceId: "ws" }, await delivery.prepareRuntime({ workspaceId: "ws" }))
  return configApplied.mock.calls.at(-1)?.[0]
}

test("the first push for an owner who never chose a default keeps the runner the sandbox was provisioned with", async () => {
  expect((await firstPush({ version: 3, connections: {}, sandbox_driver: {} }))?.defaultHarness).toEqual({ kind: "native", harnessId: "pi" })
})

test("an owner's own default replaces the provisioned runner", async () => {
  expect((await firstPush({ version: 3, connections: {}, sandbox_driver: {}, defaultHarness: { kind: "native", harnessId: "claude" } }))?.defaultHarness)
    .toEqual({ kind: "native", harnessId: "claude" })
})

test("settings carry the materialized plugin launch rows and explicit withdrawal", async () => {
  const config: UserAgentConfig = { version: 3, connections: {}, sandbox_driver: {} }
  const plugins = { harnessLaunch: { claude: { generation: "plugin-generation" } }, mcp: {} }
  expect((await firstPush(config, plugins))?.harnessLaunch).toEqual(plugins.harnessLaunch)
  expect((await firstPush(config))?.harnessLaunch).toEqual({})
})

test("a disabled default connection is refused before settings are delivered", async () => {
  configApplied.mockClear()
  await expect(firstPush({ version: 3, sandbox_driver: {}, defaultConnectionId: "acp-disabled", connections: {
    "acp-disabled": { connectionId: "acp-disabled", providerKey: "acp", configRevision: 1, enabled: false, config: {} },
  } })).rejects.toThrow("selected connection is not installed and enabled")
  expect(configApplied).not.toHaveBeenCalled()
})

test("readiness comes from applied settings, survives a refresh, and reports failed delivery", async () => {
  const delivery = await createDelivery({ version: 3, connections: {} })
  for (const [state, revision, ready] of [["idle", 0, false], ["applying", 1, false], ["applied", 1, true], ["applying", 2, true]] as const) {
    configStatus.mockResolvedValueOnce({ state, revision })
    expect(await delivery.runtimeProvisioned({ workspaceId: "ws" })).toBe(ready)
  }
  configStatus.mockResolvedValueOnce({ state: "failed", revision: 1, error: { code: "refused", message: "Harness refused settings" } })
  await expect(delivery.runtimeProvisioned({ workspaceId: "ws" })).rejects.toThrow("Harness refused settings")
})

test("a machine-placed workspace takes its config from its machine, never a hosted sandbox push", async () => {
  expect(await firstPush({ version: 3, connections: {}, sandbox_driver: {} }, undefined, "local-worktree")).toBeUndefined()
})
