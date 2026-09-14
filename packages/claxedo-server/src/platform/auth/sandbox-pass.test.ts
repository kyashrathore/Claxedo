import { describe, expect, test } from "vitest"
import { decodeJwt, exportPKCS8, exportSPKI, generateKeyPair, SignJWT } from "jose"
import { runtimeAccessTokenIssuer } from "@claxedo/workspace-relay"
import { mintSandboxPass, SandboxPassError, verifySandboxPass } from "./sandbox-pass"
import { memorySandboxPassRegister } from "./sandbox-pass-register"

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

class Fault extends Error {}
const fault = (name: string) => new Fault(`pass requires ${name}`)
const scope = { userId: "user-1", orgId: "org-1", workspaceId: "ws_1", projectId: "project-1", sessionId: "ses_1" } as const
const ONE = "aud-one"
const OTHER = "aud-other"

describe("sandbox pass family", () => {
  test("issues the standard claims plus the scope and operations, and reads them back", async () => {
    const { env } = await fixture()
    const now = 1_700_000_000_000
    const minted = await mintSandboxPass(
      { audience: ONE, scope, operations: ["read", "write"], extra: { server_name: "docs" }, ttlSeconds: 120, now: () => now },
      env,
      fault,
    )
    const payload = decodeJwt(minted.token)
    expect(payload).toMatchObject({
      iss: runtimeAccessTokenIssuer,
      aud: ONE,
      sub: scope.userId,
      jti: minted.jti,
      iat: now / 1_000,
      exp: now / 1_000 + 120,
      user_id: scope.userId,
      org_id: scope.orgId,
      workspace_id: scope.workspaceId,
      project_id: scope.projectId,
      session_id: scope.sessionId,
      operations: ["read", "write"],
      server_name: "docs",
    })
    expect(minted.jti).toMatch(/^[0-9a-f-]{36}$/)
    await expect(verifySandboxPass(minted.token, env, { audience: ONE, fault, now: () => now })).resolves.toEqual({
      audience: ONE,
      scope,
      operations: ["read", "write"],
      extra: { server_name: "docs" },
      jti: minted.jti,
      issuedAt: now,
      expiresAt: now + 120_000,
    })
  })

  test("omits the optional scope claims it was not given and reads them back as absent", async () => {
    const { env } = await fixture()
    const bare = { userId: "user-1", orgId: "org-1", workspaceId: "ws_1" }
    const { token } = await mintSandboxPass({ audience: ONE, scope: bare, operations: ["read"] }, env, fault)
    expect(decodeJwt(token)).not.toHaveProperty("project_id")
    expect(decodeJwt(token)).not.toHaveProperty("session_id")
    const pass = await verifySandboxPass(token, env, { audience: ONE, fault })
    expect(pass.scope).toEqual(bare)
    expect(pass.extra).toEqual({})
  })

  test("a pass minted for one audience is refused by the other audience's verifier", async () => {
    const { env } = await fixture()
    const { token } = await mintSandboxPass({ audience: ONE, scope, operations: ["read"] }, env, fault)
    await expect(verifySandboxPass(token, env, { audience: OTHER, fault })).rejects.toThrow(/"aud" claim/)
    await expect(verifySandboxPass(token, env, { audience: ONE, fault })).resolves.toMatchObject({ audience: ONE })
  })

  test("a tampered scope is refused", async () => {
    const { env, key } = await fixture()
    const { token } = await mintSandboxPass({ audience: ONE, scope, operations: ["read"] }, env, fault)
    const [header, , signature] = token.split(".")
    const payload = { ...decodeJwt(token), workspace_id: "ws_2" }
    const tampered = `${header}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${signature}`
    await expect(verifySandboxPass(tampered, env, { audience: ONE, fault })).rejects.toThrow(/signature/i)

    const resigned = await new SignJWT({ user_id: "user-2", org_id: scope.orgId, workspace_id: scope.workspaceId, operations: ["read"] })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer(runtimeAccessTokenIssuer)
      .setAudience(ONE)
      .setSubject(scope.userId)
      .setIssuedAt()
      .setExpirationTime("5m")
      .setJti("forged")
      .sign(key.privateKey)
    await expect(verifySandboxPass(resigned, env, { audience: ONE, fault })).rejects.toThrow(SandboxPassError)
    await expect(verifySandboxPass(resigned, env, { audience: ONE, fault })).rejects.toThrow("scope is invalid")
  })

  test("a signed token without a jti or with malformed operations is refused", async () => {
    const { env, key } = await fixture()
    const sign = (claims: Record<string, unknown>, jti?: string) => {
      const jwt = new SignJWT({ user_id: scope.userId, org_id: scope.orgId, workspace_id: scope.workspaceId, ...claims })
        .setProtectedHeader({ alg: "EdDSA" })
        .setIssuer(runtimeAccessTokenIssuer)
        .setAudience(ONE)
        .setSubject(scope.userId)
        .setIssuedAt()
        .setExpirationTime("5m")
      return (jti ? jwt.setJti(jti) : jwt).sign(key.privateKey)
    }
    await expect(verifySandboxPass(await sign({ operations: ["read"] }), env, { audience: ONE, fault })).rejects.toThrow("has no jti")
    await expect(verifySandboxPass(await sign({ operations: [] }, "j"), env, { audience: ONE, fault })).rejects.toThrow("scope is invalid")
    await expect(verifySandboxPass(await sign({ operations: "read" }, "j"), env, { audience: ONE, fault })).rejects.toThrow("scope is invalid")
    await expect(verifySandboxPass(await sign({ operations: ["read", 1] }, "j"), env, { audience: ONE, fault })).rejects.toThrow("scope is invalid")
    await expect(verifySandboxPass(await sign({ project_id: "" }, "j"), env, { audience: ONE, fault })).rejects.toThrow("scope is invalid")
    await expect(verifySandboxPass(await sign({}, "j"), env, { audience: ONE, fault })).resolves.toMatchObject({ operations: [] })
  })

  test("expiry is enforced", async () => {
    const { env } = await fixture()
    const minted = 1_700_000_000_000
    const { token } = await mintSandboxPass({ audience: ONE, scope, operations: ["read"], ttlSeconds: 60, now: () => minted }, env, fault)
    await expect(verifySandboxPass(token, env, { audience: ONE, fault, now: () => minted + 59_000 })).resolves.toBeTruthy()
    await expect(verifySandboxPass(token, env, { audience: ONE, fault, now: () => minted + 61_000 })).rejects.toThrow(/exp/i)
  })

  test("the lifetime defaults to 30 minutes and is capped at 60 and floored at 1", async () => {
    const { env } = await fixture()
    const now = 1_700_000_000_000
    const lifetime = async (ttlSeconds?: number) =>
      (await mintSandboxPass({ audience: ONE, scope, operations: ["read"], now: () => now, ...(ttlSeconds === undefined ? {} : { ttlSeconds }) }, env, fault))
        .expiresAt - now
    expect(await lifetime()).toBe(30 * 60_000)
    expect(await lifetime(24 * 60 * 60)).toBe(60 * 60_000)
    expect(await lifetime(1)).toBe(60_000)
    await expect(lifetime(Number.NaN)).rejects.toThrow("finite ttlSeconds")
  })

  test("refuses to mint a pass that allows nothing, names nobody, or overwrites a family claim", async () => {
    const { env } = await fixture()
    await expect(mintSandboxPass({ audience: ONE, scope, operations: [] }, env, fault)).rejects.toThrow("at least one operation")
    await expect(mintSandboxPass({ audience: ONE, scope: { ...scope, userId: " " }, operations: ["read"] }, env, fault)).rejects.toThrow(Fault)
    await expect(mintSandboxPass({ audience: ONE, scope: { ...scope, sessionId: "" }, operations: ["read"] }, env, fault)).rejects.toThrow("sessionId")
    await expect(mintSandboxPass({ audience: ONE, scope, operations: ["read"], extra: { sub: "user-2" } }, env, fault)).rejects.toThrow("pass family owns")
    await expect(mintSandboxPass({ audience: ONE, scope, operations: ["read"], extra: { workspace_id: "ws_2" } }, env, fault)).rejects.toThrow("pass family owns")
    await expect(mintSandboxPass({ audience: ONE, scope, operations: ["read"], extra: { server_name: "" } }, env, fault)).rejects.toThrow("server_name")
  })

  test("a revoked pass is refused by every verifier that asks the register, and a live one is not", async () => {
    const { env } = await fixture()
    const now = 1_700_000_000_000
    const register = memorySandboxPassRegister({ now: () => now })
    const minted = await mintSandboxPass({ audience: ONE, scope, operations: ["read"], now: () => now, register }, env, fault)
    const sibling = await mintSandboxPass({ audience: OTHER, scope, operations: ["read"], now: () => now, register }, env, fault)
    expect(await register.outstanding({ orgId: scope.orgId, audience: ONE })).toMatchObject([
      { jti: minted.jti, audience: ONE, scope, issuedAt: now, expiresAt: minted.expiresAt },
    ])
    const verify = (token: string, audience: string) =>
      verifySandboxPass(token, env, { audience, fault, now: () => now, revoked: register.revoked })
    await expect(verify(minted.token, ONE)).resolves.toMatchObject({ jti: minted.jti })

    await register.revoke({ workspaceId: scope.workspaceId, audience: ONE, reason: "tasks_group_disabled" })
    await expect(verify(minted.token, ONE)).rejects.toThrow(SandboxPassError)
    await expect(verify(minted.token, ONE)).rejects.toThrow("was revoked")
    await expect(verify(sibling.token, OTHER)).resolves.toMatchObject({ jti: sibling.jti })
    // A verifier given no register keeps answering for the signature alone.
    await expect(verifySandboxPass(minted.token, env, { audience: ONE, fault, now: () => now })).resolves.toBeTruthy()
  })

  test("names the deployment fault the audience supplied when the key is missing", async () => {
    await expect(mintSandboxPass({ audience: ONE, scope, operations: ["read"] }, {}, fault)).rejects.toThrow(Fault)
    await expect(verifySandboxPass("x.y.z", {}, { audience: ONE, fault })).rejects.toThrow("runtime verification key")
  })
})
