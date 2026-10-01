import { afterEach, expect, test, vi } from "vitest"
import { createSandboxManager, type SandboxDriver } from "@claxedo/sandbox-manager"
import { createMemoryLeaseStore } from "@claxedo/sandbox-manager/stores/memory"
import type { ControlPlaneTokenVerifier } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { ControlPlaneServices } from "../authority/services"
import { HostedWorkspaceRoutes } from "../routes/hosted/workspace"
import type { ControlPlaneDatabase } from "../test-support/control-plane-migrations"
import { workspaceBackingDatabase } from "../test-support/workspace-backing-database"
import { createHostedRuntimeDelivery } from "./hosted-runtime-delivery"

const configApplied = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("@claxedo/workspace-runtime/client", () => ({ createWorkspaceRuntimeClient: vi.fn(() => ({ applyConfig: configApplied })) }))

const verifier: ControlPlaneTokenVerifier = async (token, config) => ({
  mode: "signed" as const,
  user: { subject: token, tokenIdentifier: `${config.issuer}|${token}`, issuer: config.issuer, orgId: "org" },
})

const active: ControlPlaneDatabase[] = []
afterEach(async () => { await Promise.all(active.splice(0).map((instance) => instance.dispose())) })

const driver = {
  id: "test",
  ensureHost: async () => { throw new Error("a machine-placed workspace provisions no sandbox") },
  metadata: {
    driverRunsIn: ["node"],
    hostStopBehavior: "suspends-host",
    hostResumeBehavior: "same-host",
    targetAccess: "relay",
    secretBrokering: "native",
    egressControl: "hosts",
    persistence: {
      resume: "same-sandbox",
      capture: "none",
      clone: false,
      captureSource: "not-applicable",
      retention: "not-applicable",
      restoreMount: "not-applicable",
    },
  },
} satisfies SandboxDriver

test("a machine-placed workspace connects through its host without a hosted sandbox config push", async () => {
  const instance = await workspaceBackingDatabase([{ id: "ws_machine", backing: "local-worktree" }])
  active.push(instance)
  const sandboxManager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver })
  const authority = {
    usersMe: async () => ({ actor_id: "act_owner", actor_kind: "human" }),
    openWorkspace: async () => ({ allowed: true, role: "owner", workspace: { workspace_id: "ws_machine", org_id: "org", backing: "local-worktree" } }),
    activeWorkspaceHost: async () => ({ active: true, host_id: "host_machine", expires_at: Date.now() + 60_000 }),
    resolveWorkspaceOwner: async () => ({ userId: "owner", orgId: "org" }),
    recordRuntimeAccessToken: async () => ({}),
    auditAllow: async () => ({}),
    auditDeny: async () => ({}),
  }
  const services = {
    authority,
    sandbox: { sandboxManager, defaultDriver: driver.id },
    telemetry: { capture: vi.fn() },
  } as unknown as ControlPlaneServices
  const delivery = createHostedRuntimeDelivery({
    authority: authority as unknown as WorkspaceAuthority,
    database: instance.database,
    services,
    sandboxManager,
    driver,
    sandboxInput: async () => { throw new Error("a machine-placed workspace provisions no sandbox") },
    settings: { read: async () => ({ version: 3, connections: {}, sandbox_driver: {} }), write: async () => {} },
    credentials: () => ({ listCredentials: async () => [], accountSelections: async () => ({}) }) as never,
    signingEnv: {},
    provisionedRunner: undefined,
  })
  const app = HostedWorkspaceRoutes(services, {
    authConfig: { enabled: true, issuer: "https://issuer.test", jwksUrl: "https://issuer.test/jwks" },
    verifier,
    relayUrl: "https://relay.claxedo.test",
    runtimeAccessTokenSigner: async () => ({ runtimeAccessToken: "runtime-token", jti: "jti_1", tokenExpiresAt: Date.now() + 60_000 }),
    prepareRuntime: delivery.prepareRuntime,
    provisionRuntime: delivery.provisionRuntime,
  })

  const connected = await app.fetch(new Request("https://cp.claxedo.test/ws_machine/connection", { headers: { authorization: "Bearer owner" } }))

  expect(await connected.json()).toMatchObject({ backing: "local-worktree", runtimeAccessToken: "runtime-token" })
  expect(connected.status).toBe(200)
  expect(configApplied).not.toHaveBeenCalled()
})
