import { afterEach, expect, test, vi } from "vitest"
import type { UserAgentConfig } from "@claxedo/server-core/agent-config/config"
import type { ControlPlaneDatabase } from "../test-support/control-plane-migrations"
import { workspaceBackingDatabase } from "../test-support/workspace-backing-database"
import { createHostedRuntimeDelivery } from "./hosted-runtime-delivery"

const configApplied = vi.hoisted(() => vi.fn(async (_snapshot: import("@claxedo/workspace-runtime/config").RuntimeSnapshot) => {}))
vi.mock("@claxedo/workspace-runtime/client", () => ({ createWorkspaceRuntimeClient: vi.fn(() => ({ applyConfig: configApplied })) }))
vi.mock("@claxedo/server-core/platform/auth/runtime-access-token", () => ({ mintSupervisorBackplaneToken: vi.fn(async () => ({ supervisorBackplaneToken: "supervisor-token" })) }))

type Input = Parameters<typeof createHostedRuntimeDelivery>[0]

const active: ControlPlaneDatabase[] = []
afterEach(async () => { await Promise.all(active.splice(0).map((instance) => instance.dispose())) })

async function firstPush(config: UserAgentConfig) {
  const instance = await workspaceBackingDatabase([{ id: "ws", backing: "cloud-vm" }])
  active.push(instance)
  const delivery = createHostedRuntimeDelivery({
    authority: { resolveWorkspaceOwner: async () => ({ userId: "owner", orgId: "org" }) } as unknown as Input["authority"],
    database: instance.database,
    services: { sandbox: { sandboxManager: { target: async () => ({ status: "ready", hostId: "host", url: "https://runtime.test" }) } } } as unknown as Input["services"],
    sandboxManager: {} as Input["sandboxManager"],
    driver: { metadata: { secretBrokering: "native" } } as Input["driver"],
    sandboxInput: async () => { throw new Error("this test provisions no sandbox") },
    settings: { read: async () => config, write: async () => {} },
    credentials: () => ({ listCredentials: async () => [], accountSelections: async () => ({}) }) as unknown as ReturnType<Input["credentials"]>,
    signingEnv: {},
    provisionedRunner: "pi",
  })
  await delivery.provisionRuntime({ workspaceId: "ws" }, await delivery.prepareRuntime({ workspaceId: "ws" }))
  return configApplied.mock.calls.at(-1)![0]
}

test("the first push for an owner who never chose a default keeps the runner the sandbox was provisioned with", async () => {
  expect((await firstPush({ version: 3, connections: {}, sandbox_driver: {} })).defaultHarness).toEqual({ kind: "native", harnessId: "pi" })
})

test("an owner's own default replaces the provisioned runner", async () => {
  expect((await firstPush({ version: 3, connections: {}, sandbox_driver: {}, defaultHarness: { kind: "native", harnessId: "claude" } })).defaultHarness)
    .toEqual({ kind: "native", harnessId: "claude" })
})
