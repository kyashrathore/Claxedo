import { afterEach, expect, test, vi } from "vitest"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../../authority/services"
import { hostedHarnessRuntimeStatus, hostedRuntimeProviderCatalog } from "./harness-runtime"

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

test("a stopped workspace has no engine catalog and does not mint or wake compute", async () => {
  const w = world()
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
})

test("provider discovery does not hide runtime failures or malformed catalog responses", async () => {
  const w = world()
  w.fetch.mockResolvedValueOnce(Response.json({ workspaceId: "ws_a" })).mockResolvedValueOnce(new Response("runtime failed", { status: 502 }))
  await expect(w.read(auth, "ws_a")).rejects.toThrow("runtime failed")
  w.fetch.mockResolvedValueOnce(Response.json({ workspaceId: "ws_a" })).mockResolvedValueOnce(Response.json([{ id: "incomplete" }]))
  await expect(w.read(auth, "ws_a")).rejects.toThrow()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function pausedWorld() {
  const events: string[] = []
  const gates = new Map<string, ReturnType<typeof deferred<void>>>()
  const step = async <T>(name: string, value: T) => {
    events.push(`${name}:start`)
    const gate = deferred<void>()
    gates.set(name, gate)
    await gate.promise
    events.push(`${name}:end`)
    return value
  }
  const health = { ok: true, status: "ready", harness: { kind: "native", harnessId: "pi" }, model: "anthropic/claude" }
  const fetch = vi.fn(async (url: string) => Response.json(await step(new URL(url).pathname.endsWith("/global/health") ? "identity" : "health", url.endsWith("/global/health") ? { workspaceId: "ws_a" } : health)))
  vi.stubGlobal("fetch", fetch)
  const mint = vi.fn(async () => ({ token: "runtime-token" }))
  const services = {
    authority: {
      openWorkspace: async () => await step("open", { role: "owner", workspace: { backing: "local-worktree", org_id: "org_a" } }),
      activeWorkspaceHost: async () => await step("host", { active: true, host_id: "host_a" }),
      usersMe: async () => await step("actor", { actor_id: "actor_a", actor_kind: "human" }),
    },
    relay: { provider: { mintRuntimeAccessToken: mint, getRelayEndpoint: async () => "https://relay.test" } },
  } as unknown as ControlPlaneServices
  const release = async (...names: string[]) => {
    await vi.waitFor(() => expect(names.every((name) => gates.has(name))).toBe(true))
    for (const name of names) gates.get(name)?.resolve()
  }
  return { status: hostedHarnessRuntimeStatus(services), events, release, mint, health }
}

test("a machine workspace's harness status resolves its host and actor together and reads identity and health together under one token", async () => {
  const w = pausedWorld()
  const probe = w.status(auth, { workspaceId: "ws_a" })
  await w.release("open")
  await w.release("host", "actor")
  await w.release("identity", "health")
  expect(await probe).toEqual({ ok: true, status: "ready", harness: { kind: "native", harnessId: "pi" }, model: "anthropic/claude" })
  expect(w.events).toEqual(["open:start", "open:end", "host:start", "actor:start", "host:end", "actor:end", "identity:start", "health:start", "identity:end", "health:end"])
  expect(w.mint).toHaveBeenCalledTimes(1)
})

test("a harness status whose runtime answers for another workspace reports the mismatch, not the health it read", async () => {
  const w = pausedWorld()
  vi.mocked(fetch).mockImplementationOnce(async () => Response.json({ workspaceId: "ws_other" }))
  const probe = w.status(auth, { workspaceId: "ws_a" })
  await w.release("open")
  await w.release("host", "actor")
  await w.release("health")
  expect(await probe).toEqual({ ok: false, status: "error", error: "Workspace runtime identity does not match requested workspace" })
})
