import { describe, expect, test } from "bun:test"
import { generateKeyPair, SignJWT } from "jose"
import { createWorkspaceRuntimeApp } from "../server"
import { relayWorkspaceRuntimeExposure } from "../exposure"
import { managedWorkspaceSessionAccessPolicy } from "../session-access-policy"
import { createWorkspaceRuntimeJwtManagementAuth, WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER } from "../management-auth"

const target = { workspaceId: "ws_checkpoint", hostId: "host_checkpoint" }
const issuer = "checkpoint-test-supervisor"
const audience = "workspace-runtime-management"
const operations = ["freeze", "flush", "scrub", "resume", "restore-reconcile"] as const

async function fixture() {
  const pair = await generateKeyPair("EdDSA")
  const relayHostAuth = { ...target, key: pair.publicKey }
  let currentRole: "viewer" | "editor" | "admin" | "owner" | undefined = "admin"
  const asked: string[] = []
  const runtime = createWorkspaceRuntimeApp({
    exposure: relayWorkspaceRuntimeExposure(relayHostAuth),
    managementTarget: target,
    managementAuth: createWorkspaceRuntimeJwtManagementAuth({ key: pair.publicKey, issuer, audience }),
    sessionAccessPolicy: {
      ...managedWorkspaceSessionAccessPolicy({ requireActor: true }),
      sessionAuthority: "managed-private",
      authorizeHost(input) {
        expect(input.authority?.workspaceId).toBe(target.workspaceId)
        expect(input.actor?.actorId).toBe("actor_checkpoint")
        expect(input.minimumRole).toBe("admin")
        asked.push(input.operation)
        return currentRole === "admin" || currentRole === "owner"
          ? { allowed: true }
          : { allowed: false, status: 403, code: "host_access_denied", message: "Current admin required" }
      },
    },
  })
  async function management(claims: Record<string, unknown> = {}, signingKey = pair.privateKey, expiration: string | number = "1m") {
    return await new SignJWT({
      workspace_id: target.workspaceId,
      host_id: target.hostId,
      action: "runtime.config.apply",
      scopes: ["runtime.config.apply", "runtime.checkpoint.control"],
      ...claims,
    }).setProtectedHeader({ alg: "EdDSA" }).setIssuer(issuer).setAudience(audience)
      .setSubject("supervisor").setIssuedAt().setExpirationTime(expiration).sign(signingKey)
  }
  async function relay(role: "viewer" | "editor" | "admin" | "owner") {
    return await new SignJWT({
      principal_kind: "user", actor_id: "actor_checkpoint", actor_kind: "human",
      org_id: "org_checkpoint", workspace_id: target.workspaceId, host_id: target.hostId,
      role, backing: "cloud-vm", parent_jti: "parent_checkpoint",
    }).setProtectedHeader({ alg: "EdDSA" }).setIssuer("workspace-relay").setAudience("workspace-host-service")
      .setIssuedAt().setExpirationTime("1m").setJti("relay_checkpoint").sign(pair.privateKey)
  }
  function request(operation: typeof operations[number], headers: Record<string, string>) {
    return runtime.app.request(`/api/wr/checkpoint/${operation}`, {
      method: "POST", headers: {
        "content-type": "application/json", "x-workspace-id": target.workspaceId,
        "x-forwarded-by": "workspace-relay", ...headers,
      },
      body: JSON.stringify({ policy: "drain", epoch: 1, checkpointId: "checkpoint_1" }),
    })
  }
  return { runtime, management, relay, request, asked, setRole: (role: typeof currentRole) => { currentRole = role } }
}

describe("checkpoint operation authority", () => {
  test("supervisor management grant reaches the real relay-mounted checkpoint route", async () => {
    const f = await fixture()
    try {
      const headers = { [WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER]: await f.management() }
      expect((await f.request("freeze", headers)).status).toBe(200)
      expect(f.runtime.host.checkpoint.detail().state).toBe("frozen")
      expect((await f.request("resume", headers)).status).toBe(200)
      expect(f.runtime.host.checkpoint.detail().state).toBe("active")
      expect(f.asked).toEqual([])
      // The same header must not bypass admission for unrelated routes.
      expect((await f.runtime.app.request("/api/wr/sessions", { headers })).status).toBe(401)
    } finally { await f.runtime.dispose() }
  })

  test.each([
    ["wrong workspace", { workspace_id: "other" }, 403],
    ["wrong host", { host_id: "other" }, 403],
    ["config-only scope", { scopes: ["runtime.config.apply"] }, 403],
  ] as const)("rejects %s management grants before every mutation", async (_name, claims, status) => {
    const f = await fixture()
    try {
      const headers = { [WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER]: await f.management(claims) }
      for (const operation of operations) expect((await f.request(operation, headers)).status).toBe(status)
      expect(f.runtime.host.checkpoint.detail().state).toBe("active")
    } finally { await f.runtime.dispose() }
  })

  test("forged or empty management grants cannot fall through to a valid admin relay grant", async () => {
    const f = await fixture()
    try {
      const other = await generateKeyPair("EdDSA")
      const authorization = `Bearer ${await f.relay("admin")}`
      for (const token of ["", "invalid", await f.management({}, other.privateKey), await f.management({}, undefined, "-1m")]) {
        for (const operation of operations) {
          expect((await f.request(operation, { authorization, [WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER]: token })).status).toBe(401)
        }
      }
      expect(f.asked).toEqual([])
      expect(f.runtime.host.checkpoint.detail().state).toBe("active")
    } finally { await f.runtime.dispose() }
  })

  test.each(["viewer", "editor"] as const)("current %s cannot mutate any checkpoint operation", async (role) => {
    const f = await fixture()
    try {
      f.setRole(role)
      const headers = { authorization: `Bearer ${await f.relay(role)}` }
      for (const operation of operations) expect((await f.request(operation, headers)).status).toBe(403)
      expect(f.asked).toEqual(operations.map(() => "checkpoint_write"))
      expect(f.runtime.host.checkpoint.detail().state).toBe("active")
    } finally { await f.runtime.dispose() }
  })

  test.each(["admin", "owner"] as const)("current %s succeeds and revocation takes effect with the same relay token", async (role) => {
    const f = await fixture()
    try {
      f.setRole(role)
      const headers = { authorization: `Bearer ${await f.relay(role)}` }
      expect((await f.request("freeze", headers)).status).toBe(200)
      f.setRole(undefined)
      expect((await f.request("resume", headers)).status).toBe(403)
      expect(f.runtime.host.checkpoint.detail().state).toBe("frozen")
      f.setRole(role)
      expect((await f.request("resume", headers)).status).toBe(200)
      expect(f.runtime.host.checkpoint.detail().state).toBe("active")
      expect(f.asked).toEqual(["checkpoint_write", "checkpoint_write", "checkpoint_write"])
    } finally { await f.runtime.dispose() }
  })
})
