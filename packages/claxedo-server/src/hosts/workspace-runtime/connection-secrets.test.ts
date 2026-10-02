import os from "node:os"
import path from "node:path"
import { expect, test, vi } from "vitest"
import { testSessionCore } from "@claxedo/session-core/testing"
import { withSessionCore } from "@claxedo/workspace-runtime/testing"
import type { ConnectionSecretResolver } from "@claxedo/agent-runtime-contract"
import { claxedoWorkspaceRuntimeBootFromEnv } from "./runtime-boot"

const WORKSPACE = path.join(os.tmpdir(), "sandbox-workspace")
const endpoint = "https://control.test/api/runtime-authority/connection-secrets/workspace-1"
const owner = { kind: "person" as const, userId: "user-carol" }
const descriptor = { connectionId: "custom-acp", providerKey: "acp", configRevision: 7, enabled: true, config: {}, secretRefs: { token: "ref-1" } }

async function bootResolver() {
  const boot = await claxedoWorkspaceRuntimeBootFromEnv({
    WORKSPACE_RUNTIME_WORKSPACE_ID: "workspace-1", WORKSPACE_RUNTIME_DIRECTORY: WORKSPACE,
    WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL: "https://control.test/api/runtime-authority/session-authorize",
  })
  const core = testSessionCore(WORKSPACE, "workspace-1")
  const resolve: ConnectionSecretResolver = (input) => withSessionCore(core, () => boot.options.resolveConnectionSecrets!(input))
  return { resolve, contributions: boot.options.routeContributions?.map((contribution) => contribution.id) }
}

test("sandbox boot leases a request's connection secrets with the relay proof that request carried", async () => {
  const { resolve } = await bootResolver()
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({
    secrets: { token: "leased-secret" }, secretLeaseGeneration: "revision-1", expiresAt: Date.now() + 60_000,
  }))
  try {
    expect(await resolve({ directory: WORKSPACE, descriptor, authority: { kind: "request", credential: "Bearer relay-proof" }, owner }))
      .toEqual({ secrets: { token: "leased-secret" }, secretLeaseGeneration: "revision-1" })
    expect(fetcher).toHaveBeenCalledWith(endpoint, expect.objectContaining({
      headers: { authorization: "Bearer relay-proof", "content-type": "application/json" },
      body: JSON.stringify({ connectionId: "custom-acp", providerKey: "acp", configRevision: 7, ownerUserId: "user-carol" }),
    }))
  } finally { fetcher.mockRestore() }
})

test("sandbox boot leases a background turn's connection secrets with the turn's own lease and no request", async () => {
  const { resolve, contributions } = await bootResolver()
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({
    secrets: { token: "leased-secret" }, secretLeaseGeneration: "revision-1", expiresAt: Date.now() + 60_000,
  }))
  try {
    expect(await resolve({ directory: WORKSPACE, descriptor, authority: { kind: "turn", lease: "signed-turn-lease" }, owner }))
      .toEqual({ secrets: { token: "leased-secret" }, secretLeaseGeneration: "revision-1" })
    expect(fetcher).toHaveBeenCalledWith(endpoint, expect.objectContaining({
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId: "custom-acp", providerKey: "acp", configRevision: 7, ownerUserId: "user-carol",
        turnLease: "signed-turn-lease" }),
    }))
    expect(contributions).not.toContain("connection-secrets")
  } finally { fetcher.mockRestore() }
})

test("sandbox boot refuses a lease no admitted operation proves, or no person owns, without asking the control plane", async () => {
  const { resolve } = await bootResolver()
  const fetcher = vi.spyOn(globalThis, "fetch")
  try {
    await expect(Promise.resolve().then(() => resolve({ directory: WORKSPACE, descriptor, owner })))
      .rejects.toMatchObject({ code: "connection_unavailable", reason: "resolver_failed",
        cause: new Error("Connection secret lease requires the authority its operation was admitted under") })
    await expect(Promise.resolve().then(() => resolve({ directory: WORKSPACE, descriptor, owner: { kind: "machine-owner" },
      authority: { kind: "turn", lease: "signed-turn-lease" } })))
      .rejects.toMatchObject({ code: "connection_unavailable", reason: "resolver_failed" })
    expect(fetcher).not.toHaveBeenCalled()
  } finally { fetcher.mockRestore() }
})

test("sandbox boot refuses a lease for a directory its runtime does not serve, without asking the control plane", async () => {
  const { resolve } = await bootResolver()
  const fetcher = vi.spyOn(globalThis, "fetch")
  try {
    await expect(Promise.resolve().then(() => resolve({ directory: "/elsewhere", descriptor, owner, authority: { kind: "turn", lease: "signed-turn-lease" } })))
      .rejects.toMatchObject({ code: "workspace_target_pinned" })
    expect(fetcher).not.toHaveBeenCalled()
  } finally { fetcher.mockRestore() }
})
