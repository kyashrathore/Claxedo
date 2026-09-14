import { describe, expect, test } from "vitest"
import { decodeJwt, exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { runtimeAccessTokenIssuer } from "@claxedo/workspace-relay"
import type { TasksCapabilityOwner } from "@claxedo/server-core/tasks-host/capability"
import { WORKSPACE_RUNTIME_OWNER_GRANT, workspaceRuntimeOwnerGrantToken } from "@claxedo/server-core/hosts/workspace-runtime/env"
import { memorySandboxPassRegister } from "../platform/auth/sandbox-pass-register"
import { mintTasksCapability, verifyTasksCapability } from "../tasks/capability"
import {
  OWNER_GRANT_AUDIENCE,
  createOwnerRootCapability,
  createOwnerRootGrant,
  isOwnerGrantToken,
  mintOwnerGrant,
  verifyOwnerGrant,
} from "./owner-grant"

async function signingEnv() {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  return {
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
  }
}

const scope = { userId: "alice", actorId: "actor:alice", orgId: "org-1", projectId: "project-a", workspaceId: "ws_root" } as const
const root = { userId: "alice", orgId: "org-1", projectId: "project-a", workspaceId: "ws_root" } as const
const owner: TasksCapabilityOwner = { userId: "alice", actorId: "actor:alice", orgId: "org-1", projectId: "project-a" }

describe("the owner grant", () => {
  test("names one workspace and its owner's actor, and reads them back", async () => {
    const env = await signingEnv()
    const now = 1_700_000_000_000
    const minted = await mintOwnerGrant(scope, env, { now: () => now, ttlSeconds: 120 })
    expect(decodeJwt(minted.token)).toMatchObject({
      iss: runtimeAccessTokenIssuer,
      aud: OWNER_GRANT_AUDIENCE,
      sub: "alice",
      jti: minted.jti,
      user_id: "alice",
      org_id: "org-1",
      project_id: "project-a",
      workspace_id: "ws_root",
      actor_id: "actor:alice",
      operations: ["sessions"],
      exp: now / 1_000 + 120,
    })
    expect(minted.expiresAt).toBe(now + 120_000)
    await expect(verifyOwnerGrant(minted.token, env, { now: () => now })).resolves.toEqual(scope)
    expect(isOwnerGrantToken(minted.token)).toBe(true)
  })

  test("is refused once expired, and a foreign key or tampered payload never verifies", async () => {
    const env = await signingEnv()
    const now = 1_700_000_000_000
    const minted = await mintOwnerGrant(scope, env, { now: () => now, ttlSeconds: 60 })
    await expect(verifyOwnerGrant(minted.token, env, { now: () => now + 61_000 })).rejects.toThrow(/exp/i)

    const foreign = await mintOwnerGrant(scope, await signingEnv())
    await expect(verifyOwnerGrant(foreign.token, env)).rejects.toThrow(/signature/i)

    const [header, , signature] = minted.token.split(".")
    const tampered = `${header}.${Buffer.from(JSON.stringify({ ...decodeJwt(minted.token), actor_id: "actor:mallory" })).toString("base64url")}.${signature}`
    await expect(verifyOwnerGrant(tampered, env, { now: () => now })).rejects.toThrow(/signature/i)
  })

  test("a Tasks capability is not an owner grant and an owner grant is not a Tasks capability", async () => {
    const env = await signingEnv()
    const tasks = await mintTasksCapability({ ...root, operations: ["read"] }, env)
    const grant = await mintOwnerGrant(scope, env)
    expect(isOwnerGrantToken(tasks.token)).toBe(false)
    expect(isOwnerGrantToken("not.a.jwt")).toBe(false)
    await expect(verifyOwnerGrant(tasks.token, env)).rejects.toThrow(/"aud" claim/)
    await expect(verifyTasksCapability(grant.token, env)).rejects.toThrow(/"aud" claim/)
  })

  test("is written to the register it is minted with and refused once its workspace's owner grants are revoked", async () => {
    const env = await signingEnv()
    const register = memorySandboxPassRegister()
    const minted = await mintOwnerGrant(scope, env, { register })
    expect(await register.outstanding({ orgId: "org-1", audience: OWNER_GRANT_AUDIENCE })).toMatchObject([
      { jti: minted.jti, scope: { userId: "alice", orgId: "org-1", projectId: "project-a", workspaceId: "ws_root" } },
    ])
    await expect(verifyOwnerGrant(minted.token, env, { revoked: register.revoked })).resolves.toEqual(scope)
    await register.revoke({ workspaceId: "ws_root", audience: OWNER_GRANT_AUDIENCE, reason: "subagents_group_disabled" })
    await expect(verifyOwnerGrant(minted.token, env, { revoked: register.revoked })).rejects.toThrow("was revoked")
  })

  test("a deployment without the signing key names its own fault", async () => {
    await expect(mintOwnerGrant(scope, {})).rejects.toThrow("Owner grant requires runtime signing key")
    await expect(verifyOwnerGrant("x.y.z", {})).rejects.toThrow("Owner grant requires runtime verification key")
  })
})

describe("the owner grant a cloud root is launched with", () => {
  test("names the actor the authority resolves for the workspace, as the environment the sandbox reads", async () => {
    const env = await signingEnv()
    const passes = memorySandboxPassRegister()
    const capability = createOwnerRootCapability({ signingEnv: env, passes, workspaceOwner: async (id) => (id === "ws_root" ? owner : undefined) })
    const environment = await capability(root)
    expect(Object.keys(environment)).toEqual([WORKSPACE_RUNTIME_OWNER_GRANT])
    const token = workspaceRuntimeOwnerGrantToken(environment)
    if (!token) throw new Error("the launch environment carries no owner grant")
    await expect(verifyOwnerGrant(token, env, { revoked: passes.revoked })).resolves.toEqual(scope)
    expect(await passes.outstanding({ orgId: "org-1", audience: OWNER_GRANT_AUDIENCE })).toHaveLength(1)
  })

  test("refuses to launch a root whose workspace has no owner, or one the authority records for someone else", async () => {
    const env = await signingEnv()
    const passes = memorySandboxPassRegister()
    for (const resolved of [undefined, { ...owner, userId: "bob", actorId: "actor:bob" }, { ...owner, orgId: "org-2" }, { ...owner, projectId: "project-b" }]) {
      const grant = createOwnerRootGrant({ signingEnv: env, passes, workspaceOwner: async () => resolved })
      await expect(grant(root)).rejects.toThrow("has no owner this control plane can launch it as")
    }
    expect(await passes.outstanding({ orgId: "org-1", audience: OWNER_GRANT_AUDIENCE })).toEqual([])
  })
})
