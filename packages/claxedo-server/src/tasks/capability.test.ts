import { describe, expect, test } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair, jwtVerify, SignJWT } from "jose"
import { runtimeAccessTokenAudience, runtimeAccessTokenIssuer } from "@claxedo/workspace-relay"
import { MCP_GATEWAY_TOKEN_AUDIENCE } from "../agent-plugins/mcp/runtime-token"
import { TASKS_CAPABILITY_AUDIENCE, mintTasksCapability, verifyTasksCapability } from "./capability"
import { memorySandboxPassRegister } from "../platform/auth/sandbox-pass-register"

async function fixture() {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  return {
    env: {
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
    },
    key,
  }
}

const scope = {
  userId: "user-1",
  orgId: "org-1",
  projectId: "project-1",
  workspaceId: "ws_root",
  sessionId: "ses_1",
  operations: ["read", "create"],
} as const

describe("Tasks capability", () => {
  test("is written to the register it is minted with and refused once its workspace's Tasks passes are revoked", async () => {
    const { env } = await fixture()
    const register = memorySandboxPassRegister()
    const minted = await mintTasksCapability(scope, env, { register })
    expect(await register.outstanding({ orgId: scope.orgId, audience: TASKS_CAPABILITY_AUDIENCE })).toMatchObject([
      { jti: minted.jti, scope: { userId: scope.userId, orgId: scope.orgId, projectId: scope.projectId, workspaceId: scope.workspaceId, sessionId: scope.sessionId } },
    ])
    await expect(verifyTasksCapability(minted.token, env, { revoked: register.revoked })).resolves.toEqual(scope)

    await register.revoke({ workspaceId: scope.workspaceId, audience: TASKS_CAPABILITY_AUDIENCE, reason: "tasks_group_disabled" })
    await expect(verifyTasksCapability(minted.token, env, { revoked: register.revoked })).rejects.toThrow("was revoked")
  })

  test("round trips one workspace's scope and the operations it grants", async () => {
    const { env } = await fixture()
    const now = Date.now()
    const minted = await mintTasksCapability(scope, env, { now: () => now, ttlSeconds: 120 })
    await expect(verifyTasksCapability(minted.token, env)).resolves.toEqual(scope)
    expect(minted.expiresAt).toBe((Math.floor(now / 1_000) + 120) * 1_000)
  })

  test("caps and floors the requested lifetime", async () => {
    const { env } = await fixture()
    const now = 1_000_000_000_000
    const long = await mintTasksCapability(scope, env, { now: () => now, ttlSeconds: 24 * 60 * 60 })
    const short = await mintTasksCapability(scope, env, { now: () => now, ttlSeconds: 1 })
    expect(long.expiresAt).toBe((Math.floor(now / 1_000) + 60 * 60) * 1_000)
    expect(short.expiresAt).toBe((Math.floor(now / 1_000) + 60) * 1_000)
  })

  test("is refused once it has expired", async () => {
    const { env } = await fixture()
    const now = Date.now() - 10 * 60_000
    const { token } = await mintTasksCapability(scope, env, { now: () => now, ttlSeconds: 60 })
    await expect(verifyTasksCapability(token, env)).rejects.toThrow(/exp/i)
  })

  test("is refused when signed by another key", async () => {
    const mine = await fixture()
    const theirs = await fixture()
    const { token } = await mintTasksCapability(scope, theirs.env)
    await expect(verifyTasksCapability(token, mine.env)).rejects.toThrow()
  })

  test("is refused when a claim is re-scoped after signing", async () => {
    const { env, key } = await fixture()
    const forged = await new SignJWT({
      user_id: scope.userId,
      org_id: scope.orgId,
      project_id: "project-2",
      workspace_id: scope.workspaceId,
      operations: ["read", "create", "start"],
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer(runtimeAccessTokenIssuer)
      .setAudience(TASKS_CAPABILITY_AUDIENCE)
      .setSubject("user-2")
      .setIssuedAt()
      .setExpirationTime("5m")
      .setJti("forged")
      .sign(key.privateKey)
    await expect(verifyTasksCapability(forged, env)).rejects.toThrow("scope is invalid")
  })

  test("has its own audience and cannot be replayed as relay access or a gateway credential", async () => {
    const { env, key } = await fixture()
    const { token } = await mintTasksCapability(scope, env)
    await expect(jwtVerify(token, key.publicKey, { audience: runtimeAccessTokenAudience })).rejects.toThrow()
    await expect(jwtVerify(token, key.publicKey, { audience: MCP_GATEWAY_TOKEN_AUDIENCE })).rejects.toThrow()
    await expect(jwtVerify(token, key.publicKey, { audience: TASKS_CAPABILITY_AUDIENCE })).resolves.toBeTruthy()
  })

  test("refuses to mint a grant that allows nothing", async () => {
    const { env } = await fixture()
    await expect(mintTasksCapability({ ...scope, operations: [] }, env)).rejects.toThrow("at least one operation")
  })

  test("refuses a token whose operations are not operations", async () => {
    const { env, key } = await fixture()
    const forged = await new SignJWT({
      user_id: scope.userId,
      org_id: scope.orgId,
      project_id: scope.projectId,
      workspace_id: scope.workspaceId,
      operations: ["read", "delete"],
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer(runtimeAccessTokenIssuer)
      .setAudience(TASKS_CAPABILITY_AUDIENCE)
      .setSubject(scope.userId)
      .setIssuedAt()
      .setExpirationTime("5m")
      .setJti("forged")
      .sign(key.privateKey)
    await expect(verifyTasksCapability(forged, env)).rejects.toThrow("scope is invalid")
  })
})
