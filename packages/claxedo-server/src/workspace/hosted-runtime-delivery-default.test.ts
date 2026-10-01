import { expect, test, vi } from "vitest"
import type { UserAgentConfig } from "@claxedo/server-core/agent-config/config"
import { createHostedRuntimeDelivery } from "./hosted-runtime-delivery"
import { hostedRuntimeConfigApply } from "./hosted-runtime"

vi.mock("./hosted-runtime", () => ({ hostedRuntimeConfigApply: vi.fn(async () => {}) }))

type Input = Parameters<typeof createHostedRuntimeDelivery>[0]

async function firstPush(config: UserAgentConfig) {
  const delivery = createHostedRuntimeDelivery({
    authority: { resolveWorkspaceOwner: async () => ({ userId: "owner", orgId: "org" }) } as unknown as Input["authority"],
    services: {} as Input["services"],
    sandboxManager: {} as Input["sandboxManager"],
    driver: { metadata: { secretBrokering: "native" } } as Input["driver"],
    sandboxInput: async () => { throw new Error("this test provisions no sandbox") },
    settings: { read: async () => config, write: async () => {} },
    credentials: () => ({ listCredentials: async () => [], accountSelections: async () => ({}) }) as unknown as ReturnType<Input["credentials"]>,
    signingEnv: {},
    provisionedRunner: "pi",
  })
  await delivery.provisionRuntime({ workspaceId: "ws" }, await delivery.prepareRuntime({ workspaceId: "ws" }))
  return vi.mocked(hostedRuntimeConfigApply).mock.calls.at(-1)![2]
}

test("the first push for an owner who never chose a default keeps the runner the sandbox was provisioned with", async () => {
  expect((await firstPush({ version: 3, connections: {}, sandbox_driver: {} })).defaultHarness).toEqual({ kind: "native", harnessId: "pi" })
})

test("an owner's own default replaces the provisioned runner", async () => {
  expect((await firstPush({ version: 3, connections: {}, sandbox_driver: {}, defaultHarness: { kind: "native", harnessId: "claude" } })).defaultHarness)
    .toEqual({ kind: "native", harnessId: "claude" })
})
