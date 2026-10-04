import { afterEach, expect, test, vi } from "vitest"
import { decodeJwt, exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import type { SandboxDriver } from "@claxedo/sandbox-manager"
import type { ControlPlaneServices } from "../../authority/services"
import { createD1SandboxLeaseStore } from "../../sandbox/stores/d1"
import { miniflareControlPlaneDatabase } from "../../test-support/control-plane-migrations"
import { composeWithCloudSandbox } from "./full-hosted-sandbox"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const step of cleanup.splice(0)) await step()
})

test("the composed plane's ready sandbox is handed a pass for its lease epoch over the relay, and that plane's ingest admits it", async () => {
  const backing = await miniflareControlPlaneDatabase()
  cleanup.push(() => backing.dispose())
  const key = await generateKeyPair("EdDSA", { extractable: true })
  const signingEnv = {
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
  }
  const leases = createD1SandboxLeaseStore({ database: backing.database })
  const { lease } = await leases.acquire("ws_cloud", { homeRegion: "us-east", driver: "test", staleAfterMs: 0 })
  await leases.recordTarget("ws_cloud", lease.epoch, { sandboxId: "sb_1", url: "https://sandbox.test", hostId: "host_cloud", labels: {} })
  const relayed: Array<{ url: string; method: string; body?: string }> = []
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    relayed.push({ url, method: init?.method ?? "GET", ...(typeof init?.body === "string" ? { body: init.body } : {}) })
    return init?.method === "GET" ? Response.json({ held: null }) : new Response(null, { status: 204 })
  }))
  const owner = { userId: "usr_owner", actorId: "act_owner", orgId: "org_1", projectId: "prj_1" }
  const services = {
    authority: { resolveWorkspaceOwner: async () => owner },
    sandbox: { sandboxManager: { target: async () => ({ status: "ready", hostId: "host_cloud", routingId: "routing_1", homeRegion: "us-east", url: "https://sandbox.test", epoch: lease.epoch }) } },
    relay: { provider: { mintRuntimeAccessToken: async () => ({ token: "rat" }), getRelayEndpoint: async () => "https://relay.test" } },
  } as unknown as ControlPlaneServices
  const driver = { id: "test" } as unknown as SandboxDriver

  const composed = composeWithCloudSandbox({ database: backing.database, signingEnv, driver, keyDrivers: { drivers: [], create: () => undefined } }, (extra) => ({ plane: { services }, extra }))
  await composed.extra.sandbox.deliverSessionRowsPass!("ws_cloud")

  expect(composed.extra.sandbox.driver).toBe(driver)
  expect(relayed.map((call) => `${call.method} ${call.url}`)).toEqual([
    "GET https://relay.test/workspaces/ws_cloud/api/claxedo/session-rows/pass",
    "PUT https://relay.test/workspaces/ws_cloud/api/claxedo/session-rows/pass",
  ])
  const { token } = JSON.parse(relayed[1]?.body ?? "{}") as { token: string }
  expect(decodeJwt(token)).toMatchObject({ workspace_id: "ws_cloud", user_id: "usr_owner", lease_epoch: String(lease.epoch) })
  await expect(composed.extra.sessionRowsPasses.admit(token, "host_cloud")).resolves.toMatchObject({ workspaceIds: ["ws_cloud"], lease: { epoch: lease.epoch } })
})
