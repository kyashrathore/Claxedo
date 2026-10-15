import { afterEach, expect, test, vi } from "vitest"
import type { D1Database } from "@cloudflare/workers-types"
import { RUNTIME_LEASE_ENV_PATH } from "@claxedo/server-core/hosts/workspace-runtime/env"
import { createHostedRuntimeDelivery } from "./hosted-runtime-delivery"
import { unusedSandboxRedeliver, unusedSandboxStart, unusedWorkspaceIdleStop } from "../test-support/inline-sandbox-start"
import type { ControlPlaneDatabase } from "../test-support/control-plane-migrations"
import { workspaceBackingDatabase } from "../test-support/workspace-backing-database"

vi.mock("@claxedo/workspace-runtime/client", () => ({ createWorkspaceRuntimeClient: vi.fn(() => ({
  applyConfig: async () => {},
  configStatus: async () => ({ state: "applied", revision: 1 }),
})) }))
vi.mock("@claxedo/server-core/platform/auth/runtime-access-token", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@claxedo/server-core/platform/auth/runtime-access-token")>()),
  mintSupervisorBackplaneToken: vi.fn(async () => ({ supervisorBackplaneToken: "supervisor-token" })),
}))

const active: ControlPlaneDatabase[] = []
afterEach(async () => { await Promise.all(active.splice(0).map((instance) => instance.dispose())) })

async function composition(runtimeAnswer = 204) {
  const instance = await workspaceBackingDatabase([{ id: "ws-a", backing: "cloud-vm" }])
  active.push(instance)
  const target = async () => ({ status: "ready", hostId: "boat-ws-a", url: "https://runtime.test", epoch: 3 })
  const deliveredTo: { path: string; method?: string; body: unknown }[] = []
  type Input = Parameters<typeof createHostedRuntimeDelivery>[0]
  const delivery = createHostedRuntimeDelivery({
    sandboxRefresh: unusedSandboxStart,
    sandboxRedeliver: unusedSandboxRedeliver,
    idleStop: unusedWorkspaceIdleStop,
    authority: { resolveWorkspaceOwner: async () => ({ userId: "owner", orgId: "org", projectId: "project" }) } as unknown as Input["authority"],
    database: instance.database as unknown as D1Database,
    services: { sandbox: { sandboxManager: { target } } } as unknown as Input["services"],
    sandboxManager: { target, heartbeat: async () => ({ ok: true, status: "ready" }) } as unknown as Input["sandboxManager"],
    workspaceSecretBrokering: async () => "none",
    sandboxInput: async () => { throw new Error("this test provisions no sandbox") },
    settings: { read: async () => ({ version: 3, connections: {}, sandbox_driver: {} }), write: async () => {} },
    credentials: () => ({ listCredentials: async () => [], accountSelections: async () => ({}) }) as unknown as ReturnType<Input["credentials"]>,
    signingEnv: {},
    provisionedRunner: undefined,
    runtimeFetch: async (_workspaceId, _orgId, path, init) => {
      if (path !== RUNTIME_LEASE_ENV_PATH) return Response.json({ phases: [] })
      deliveredTo.push({ path, method: init.method, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body })
      return new Response(null, { status: runtimeAnswer })
    },
  })
  return { delivery, deliveredTo }
}

test("a serving sandbox is handed its lease env minted for the lease it serves, and is due again at half the placeholder's hour", async () => {
  const { delivery, deliveredTo } = await composition()
  const leaseEnv = vi.fn(async (lease: { epoch: number; hostId: string }) => ({ CLAXEDO_GITHUB_CLONE_AUTH: `Bearer pass-${lease.epoch}` }))
  delivery.composeRuntime({ prepareRuntime: async () => ({ leaseEnv }) })
  const before = Date.now()
  const renewAt = await delivery.start.renew("ws-a")
  expect(leaseEnv).toHaveBeenCalledWith({ epoch: 3, hostId: "boat-ws-a" })
  expect(deliveredTo).toEqual([{ path: RUNTIME_LEASE_ENV_PATH, method: "PUT", body: { CLAXEDO_GITHUB_CLONE_AUTH: "Bearer pass-3" } }])
  expect(renewAt).toBeGreaterThanOrEqual(before + 30 * 60 * 1000)
  expect(renewAt).toBeLessThan(before + 31 * 60 * 1000)
})

test("a lease env that could not be minted or taken keeps the renewal scheduled, and a preparation without one delivers none", async () => {
  const refused = await composition(503)
  refused.delivery.composeRuntime({ prepareRuntime: async () => ({ leaseEnv: async () => ({ CLAXEDO_GITHUB_CLONE_AUTH: "Bearer pass" }) }) })
  expect(await refused.delivery.start.renew("ws-a")).toBeGreaterThan(Date.now())
  expect(refused.deliveredTo).toHaveLength(1)

  const unminted = await composition()
  unminted.delivery.composeRuntime({ prepareRuntime: async () => ({ leaseEnv: async () => { throw new Error("connection_refresh_transient") } }) })
  expect(await unminted.delivery.start.renew("ws-a")).toBeGreaterThan(Date.now())
  expect(unminted.deliveredTo).toEqual([])

  const none = await composition()
  none.delivery.composeRuntime({ prepareRuntime: async () => ({}) })
  expect(await none.delivery.start.renew("ws-a")).toBeUndefined()
  expect(none.deliveredTo).toEqual([])
})
