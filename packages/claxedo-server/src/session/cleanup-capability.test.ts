import { describe, expect, test } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair, jwtVerify } from "jose"
import { memorySandboxPassRegister } from "../platform/auth/sandbox-pass-register"
import { OWNER_GRANT_AUDIENCE } from "./owner-grant"
import { mintSessionCleanupCapability, verifySessionCleanupCapability, resolveSessionCleanupOwner, SESSION_CLEANUP_AUDIENCE } from "./cleanup-capability"

export async function cleanupSigningEnvironment() {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  return { key, env: { CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey), CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey) } }
}

const root = { userId: "user-a", actorId: "actor-a", orgId: "org-a", projectId: "project-a", workspaceId: "workspace-a" }

describe("user-bound session cleanup capability", () => {
  test("is a separate revocable audience with the original owner identity", async () => {
    const { env, key } = await cleanupSigningEnvironment()
    const register = memorySandboxPassRegister()
    const minted = await mintSessionCleanupCapability(root, env, { register })
    expect(await verifySessionCleanupCapability(minted.token, env, { revoked: register.revoked })).toEqual(root)
    await expect(jwtVerify(minted.token, key.publicKey, { audience: OWNER_GRANT_AUDIENCE })).rejects.toThrow()
    await register.revoke({ workspaceId: root.workspaceId, audience: SESSION_CLEANUP_AUDIENCE, reason: "sessions_group_disabled" })
    await expect(verifySessionCleanupCapability(minted.token, env, { revoked: register.revoked })).rejects.toThrow("was revoked")
  })

  test("machine grants preserve their originating session and serving generation", async () => {
    const { env } = await cleanupSigningEnvironment()
    const scope = { ...root, sessionId: "session-a", host: { hostId: "host-a", enrollmentId: "enrollment-a", generation: 3 } }
    const minted = await mintSessionCleanupCapability(scope, env)
    expect(await verifySessionCleanupCapability(minted.token, env)).toEqual(scope)
    let allowed = true
    const input = { signingEnv: env, workspaceOwner: async () => root, enabled: async () => true, originAllowed: async () => allowed }
    expect(await resolveSessionCleanupOwner(input, scope)).toEqual(root)
    allowed = false
    expect(await resolveSessionCleanupOwner(input, scope)).toBeUndefined()
  })

  test("requires live ownership and project consent on every use", async () => {
    const { env } = await cleanupSigningEnvironment()
    let owner = root
    let enabled = true
    const input = { signingEnv: env, workspaceOwner: async () => owner, enabled: async () => enabled }
    expect(await resolveSessionCleanupOwner(input, root)).toEqual(root)
    owner = { ...root, actorId: "actor-b" }
    expect(await resolveSessionCleanupOwner(input, root)).toBeUndefined()
    owner = root
    enabled = false
    expect(await resolveSessionCleanupOwner(input, root)).toBeUndefined()
  })

  test("rejects expired tokens", async () => {
    const { env } = await cleanupSigningEnvironment()
    const minted = await mintSessionCleanupCapability(root, env, { now: () => 1_000_000, ttlSeconds: 60 })
    await expect(verifySessionCleanupCapability(minted.token, env, { now: () => 1_060_000 })).rejects.toThrow(/exp/i)
  })
})
