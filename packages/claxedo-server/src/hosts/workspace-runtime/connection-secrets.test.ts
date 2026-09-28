import { expect, test, vi } from "vitest"
import { claxedoWorkspaceRuntimeBootFromEnv } from "./runtime-boot"

const endpoint = "https://control.test/api/runtime-authority/connection-secrets/workspace-1"
const owner = { kind: "person" as const, userId: "actor-carol" }
const descriptor = { connectionId: "custom-acp", providerKey: "acp", configRevision: 7, enabled: true, config: {}, secretRefs: { token: "ref-1" } }

async function bootResolver() {
  const boot = await claxedoWorkspaceRuntimeBootFromEnv({
    WORKSPACE_RUNTIME_WORKSPACE_ID: "workspace-1", WORKSPACE_RUNTIME_DIRECTORY: "/workspace",
    WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL: "https://control.test/api/runtime-authority/session-authorize",
  })
  return { resolve: boot.options.resolveConnectionSecrets!, contributions: boot.options.routeContributions?.map((contribution) => contribution.id) }
}

test("sandbox boot leases a request's connection secrets with the relay proof that request carried", async () => {
  const { resolve } = await bootResolver()
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({
    secrets: { token: "leased-secret" }, secretLeaseGeneration: "revision-1", expiresAt: Date.now() + 60_000,
  }))
  try {
    expect(await resolve({ directory: "/workspace", descriptor, authority: { kind: "request", credential: "Bearer relay-proof" }, owner }))
      .toEqual({ secrets: { token: "leased-secret" }, secretLeaseGeneration: "revision-1" })
    expect(fetcher).toHaveBeenCalledWith(endpoint, expect.objectContaining({
      headers: { authorization: "Bearer relay-proof", "content-type": "application/json" },
      body: JSON.stringify({ connectionId: "custom-acp", providerKey: "acp", configRevision: 7, ownerActorId: "actor-carol" }),
    }))
  } finally { fetcher.mockRestore() }
})

test("sandbox boot leases a background turn's connection secrets with the turn's own lease and no request", async () => {
  const { resolve, contributions } = await bootResolver()
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({
    secrets: { token: "leased-secret" }, secretLeaseGeneration: "revision-1", expiresAt: Date.now() + 60_000,
  }))
  try {
    expect(await resolve({ directory: "/workspace", descriptor, authority: { kind: "turn", lease: "signed-turn-lease" }, owner }))
      .toEqual({ secrets: { token: "leased-secret" }, secretLeaseGeneration: "revision-1" })
    expect(fetcher).toHaveBeenCalledWith(endpoint, expect.objectContaining({
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId: "custom-acp", providerKey: "acp", configRevision: 7, ownerActorId: "actor-carol",
        turnLease: "signed-turn-lease" }),
    }))
    expect(contributions).not.toContain("connection-secrets")
  } finally { fetcher.mockRestore() }
})

test("sandbox boot refuses a lease no admitted operation proves, or no person owns, without asking the control plane", async () => {
  const { resolve } = await bootResolver()
  const fetcher = vi.spyOn(globalThis, "fetch")
  try {
    await expect(Promise.resolve().then(() => resolve({ directory: "/workspace", descriptor, owner })))
      .rejects.toMatchObject({ code: "connection_unavailable", reason: "resolver_failed",
        cause: new Error("Connection secret lease requires the authority its operation was admitted under") })
    await expect(Promise.resolve().then(() => resolve({ directory: "/workspace", descriptor, owner: { kind: "machine-owner" },
      authority: { kind: "turn", lease: "signed-turn-lease" } })))
      .rejects.toMatchObject({ code: "connection_unavailable", reason: "resolver_failed" })
    expect(fetcher).not.toHaveBeenCalled()
  } finally { fetcher.mockRestore() }
})
