import { describe, expect, test } from "bun:test"
import { exportSPKI, generateKeyPair, SignJWT } from "jose"
import {
  WORKSPACE_RUNTIME_OWNER_GRANT_AUDIENCE,
  WORKSPACE_RUNTIME_OWNER_GRANT_ISSUER,
  ownerGrantIdentity,
  ownerGrantIdentityFromEnv,
} from "./owner-grant"

const claims = { user_id: "alice", org_id: "org_1", workspace_id: "ws_1", project_id: "project_a", actor_id: "actor_alice", operations: ["sessions"] }

async function grant(key: CryptoKey, overrides: Record<string, unknown> = {}, header: { issuer?: string; audience?: string; ttl?: number } = {}) {
  const now = Math.floor(Date.now() / 1_000)
  return await new SignJWT({ ...claims, ...overrides })
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuer(header.issuer ?? WORKSPACE_RUNTIME_OWNER_GRANT_ISSUER)
    .setAudience(header.audience ?? WORKSPACE_RUNTIME_OWNER_GRANT_AUDIENCE)
    .setSubject("alice")
    .setIssuedAt(now)
    .setExpirationTime(now + (header.ttl ?? 60))
    .setJti("jti_1")
    .sign(key)
}

describe("the owner grant as the runtime reads it", () => {
  test("a grant for this workspace becomes the owner's verified identity", async () => {
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const identity = ownerGrantIdentity({ key: key.publicKey, workspaceId: "ws_1" })
    expect(await identity(await grant(key.privateKey))).toEqual({
      principal_kind: "user",
      actor_id: "actor_alice",
      actor_kind: "human",
      actor_public_id: "actor_alice",
      actor_name: "workspace owner",
      org_id: "org_1",
      workspace_id: "ws_1",
      role: "owner",
    })
  })

  test("a grant for another workspace, another audience, another issuer, another key, or an expired one is nobody", async () => {
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const other = await generateKeyPair("EdDSA", { extractable: true })
    const identity = ownerGrantIdentity({ key: key.publicKey, workspaceId: "ws_1" })
    for (const token of [
      await grant(key.privateKey, { workspace_id: "ws_2" }),
      await grant(key.privateKey, {}, { audience: "claxedo-tasks-capability" }),
      await grant(key.privateKey, {}, { issuer: "workspace-relay" }),
      await grant(other.privateKey),
      await grant(key.privateKey, {}, { ttl: -120 }),
      await grant(key.privateKey, { actor_id: "" }),
      await grant(key.privateKey, { org_id: undefined }),
      "not-a-jwt",
    ]) {
      expect(await identity(token)).toBeUndefined()
    }
  })

  test("is built from the management verification key the runtime already trusts, and is absent without one", async () => {
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const identity = await ownerGrantIdentityFromEnv({ WORKSPACE_RUNTIME_MANAGEMENT_VERIFY_PEM: await exportSPKI(key.publicKey), WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_1" })
    expect(identity).toBeDefined()
    expect(await identity!(await grant(key.privateKey))).toMatchObject({ actor_id: "actor_alice", workspace_id: "ws_1" })
    expect(await ownerGrantIdentityFromEnv({ WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_1" })).toBeUndefined()
  })
})
