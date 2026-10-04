import { afterEach, expect, test, vi } from "vitest"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../../authority/services"
import { hostedRuntimeProviderCatalog } from "./shell"

afterEach(() => vi.unstubAllGlobals())

const auth: SignedControlPlaneAuth = { mode: "signed", user: { subject: "user_a", issuer: "test", tokenIdentifier: "test|user_a" } }
const providers = [{ id: "openai", name: "OpenAI", env: [], connected: true, models: [{ providerID: "openai", id: "gpt", cost: [{ input: 1, output: 2 }] }] }]

function world() {
  const open = vi.fn(async () => ({ role: "owner", workspace: { backing: "cloud-vm", org_id: "org_a" } }))
  const target = vi.fn(async (): Promise<Record<string, unknown>> => ({ status: "ready", hostId: "host_a", routingId: "route_a", homeRegion: "us-east" }))
  const mint = vi.fn(async () => ({ token: "runtime-token" }))
  const fetch = vi.fn(async (url: string) => Response.json(url.endsWith("/global/health") ? { workspaceId: "ws_a" } : providers))
  vi.stubGlobal("fetch", fetch)
  const services = {
    authority: { openWorkspace: open, usersMe: async () => ({ actor_id: "actor_a", actor_kind: "human" }) },
    sandbox: { sandboxManager: { target } },
    relay: { provider: { mintRuntimeAccessToken: mint, getRelayEndpoint: async () => "https://relay.test" } },
  } as unknown as ControlPlaneServices
  return { read: hostedRuntimeProviderCatalog(services), open, target, mint, fetch }
}

test("hosted provider discovery verifies workspace identity and sends the caller's scoped runtime capability", async () => {
  const w = world()
  expect(await w.read(auth, "ws_a")).toEqual(providers)
  expect(w.open).toHaveBeenCalledWith(auth, { workspaceId: "ws_a" })
  expect(w.fetch.mock.calls.map(([url]) => url)).toEqual([
    "https://relay.test/workspaces/ws_a/global/health",
    "https://relay.test/workspaces/ws_a/api/wr/harness-providers?nativeHarness=opencode",
  ])
  expect(w.mint).toHaveBeenCalledWith(expect.objectContaining({ principalKind: "user", actorId: "actor_a", userId: "user_a", orgId: "org_a", workspaceId: "ws_a", role: "owner" }))
})

test("a stopped or unnamed workspace has no engine catalog and does not mint or wake compute", async () => {
  const w = world()
  expect(await w.read(auth, undefined)).toBeUndefined()
  expect(w.open).not.toHaveBeenCalled()
  w.target.mockResolvedValue({ status: "unavailable", reason: "runtime_stopped", leaseStatus: "stopped" })
  expect(await w.read(auth, "ws_a")).toBeUndefined()
  expect(w.mint).not.toHaveBeenCalled()
  expect(w.fetch).not.toHaveBeenCalled()
})

test("workspace access refusal and mismatched runtime identity never disclose models", async () => {
  const w = world()
  w.open.mockRejectedValueOnce(new ControlPlaneAuthError(403, "workspace_authorization_denied", "Denied"))
  await expect(w.read(auth, "ws_a")).rejects.toMatchObject({ status: 403 })
  expect(w.fetch).not.toHaveBeenCalled()
  w.fetch.mockResolvedValueOnce(Response.json({ workspaceId: "ws_other" }))
  await expect(w.read(auth, "ws_a")).rejects.toThrow("identity does not match")
  expect(w.fetch).toHaveBeenCalledTimes(1)
})

test("provider discovery does not hide runtime failures or malformed catalog responses", async () => {
  const w = world()
  w.fetch.mockResolvedValueOnce(Response.json({ workspaceId: "ws_a" })).mockResolvedValueOnce(new Response("runtime failed", { status: 502 }))
  await expect(w.read(auth, "ws_a")).rejects.toThrow("runtime failed")
  w.fetch.mockResolvedValueOnce(Response.json({ workspaceId: "ws_a" })).mockResolvedValueOnce(Response.json([{ id: "incomplete" }]))
  await expect(w.read(auth, "ws_a")).rejects.toThrow()
})
