import { describe, expect, test } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair, jwtVerify } from "jose"
import { runtimeAccessTokenAudience } from "@claxedo/workspace-relay"
import { MCP_GATEWAY_TOKEN_AUDIENCE, mintMcpGatewayToken, verifyMcpGatewayToken } from "./runtime-token"
import { memorySandboxPassRegister } from "../../platform/auth/sandbox-pass-register"

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
  workspaceId: "workspace-1",
  harnessId: "opencode",
  pluginInstanceId: "collection:docs",
  serverName: "docs",
  integrationId: "mcp-integration",
  artifactDigest: `sha256:${"e".repeat(64)}`,
  execution: "default",
} as const

describe("MCP gateway runtime token", () => {
  test("is written to the register it is minted with and refused once its workspace's passes are revoked", async () => {
    const { env } = await fixture()
    const register = memorySandboxPassRegister()
    const minted = await mintMcpGatewayToken(scope, env, { register })
    expect(await register.outstanding({ orgId: scope.orgId, audience: MCP_GATEWAY_TOKEN_AUDIENCE })).toMatchObject([
      { jti: minted.jti, scope: { userId: scope.userId, orgId: scope.orgId, projectId: scope.projectId, workspaceId: scope.workspaceId } },
    ])
    const expected = { integrationId: scope.integrationId }
    await expect(verifyMcpGatewayToken(minted.token, expected, env, { revoked: register.revoked })).resolves.toEqual(scope)

    await register.revoke({ workspaceId: scope.workspaceId, reason: "workspace_deleted" })
    await expect(verifyMcpGatewayToken(minted.token, expected, env, { revoked: register.revoked })).rejects.toThrow("was revoked")
  })

  test("binds a short-lived token to every runtime and plugin identity", async () => {
    const { env } = await fixture()
    const now = Date.now()
    const minted = await mintMcpGatewayToken(scope, env, { now: () => now, ttlSeconds: 120 })
    await expect(verifyMcpGatewayToken(minted.token, {
      integrationId: scope.integrationId,
    }, env)).resolves.toEqual(scope)
    expect(minted.expiresAt).toBe((Math.floor(now / 1_000) + 120) * 1_000)
    await expect(verifyMcpGatewayToken(minted.token, {
      integrationId: "other",
    }, env)).rejects.toThrow("scope is invalid")
  })

  test("has a dedicated audience and cannot be replayed as workspace-relay access", async () => {
    const { env, key } = await fixture()
    const { token } = await mintMcpGatewayToken(scope, env)
    await expect(jwtVerify(token, key.publicKey, { audience: runtimeAccessTokenAudience })).rejects.toThrow()
    await expect(jwtVerify(token, key.publicKey, { audience: MCP_GATEWAY_TOKEN_AUDIENCE })).resolves.toBeTruthy()
  })
})
