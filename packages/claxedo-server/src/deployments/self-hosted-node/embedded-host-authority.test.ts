import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { afterEach, beforeAll, afterAll, expect, test, vi } from "vitest"
import { generateKeyPair, exportPKCS8, exportSPKI, SignJWT } from "jose"
import { createSqliteWorkspaceAuthority } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority"
import { openAuthorityDb } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { createWorkspaceRuntimeApp, relayWorkspaceRuntimeExposure } from "@claxedo/workspace-runtime"
import { createRuntimeEventHub } from "@claxedo/workspace-runtime/host"
import { createBus, type WorkspaceRuntimeEvent } from "../../../../workspace-runtime/src/bus"
import { sessionEventDeliveryPolicy } from "../../../../workspace-runtime/src/event-delivery"
import { workspaceEventsHandler } from "../../../../workspace-runtime/src/routes/events"
import { sessionStreamLeaseVerifier } from "../../routes/runtime-session-authority"
import { embeddedManagedPrivateSessionPolicy } from "./app"

const keyNames = ["CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM", "CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM"] as const
const previous = keyNames.map((name) => process.env[name])
beforeAll(async () => {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  process.env[keyNames[0]] = await exportPKCS8(key.privateKey)
  process.env[keyNames[1]] = await exportSPKI(key.publicKey)
})
afterAll(() => keyNames.forEach((name, i) => {
  if (previous[i] === undefined) delete process.env[name]
  else process.env[name] = previous[i]
}))
const cleanup: Array<() => void> = []
afterEach(() => { vi.restoreAllMocks(); cleanup.splice(0).reverse().forEach((close) => close()) })
const auth = (subject: string): SignedControlPlaneAuth => ({
  mode: "signed", token: `token_${subject}`,
  user: { subject, tokenIdentifier: `https://idp.example|${subject}`, issuer: "https://idp.example" },
})

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "embedded-host-authority-"))
  const file = path.join(directory, "authority.db")
  const authority = createSqliteWorkspaceAuthority({ path: file })
  const database = openAuthorityDb({ path: file })
  cleanup.push(() => { authority.close(); database.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  const owner = auth("owner"), member = auth("member")
  await authority.createCloudWorkspace(owner, { workspaceId: "ws_current", displayName: "Current" })
  await authority.usersMe(member)
  const row = database().prepare("SELECT org_id, project_id FROM workspaces WHERE workspace_id = ?").get("ws_current") as { org_id: string; project_id: string }
  const role = (value?: string) => {
    database().prepare("DELETE FROM project_memberships WHERE project_id = ? AND token_identifier = ?").run(row.project_id, member.user.tokenIdentifier)
    if (value) database().prepare("INSERT INTO project_memberships (project_id, token_identifier, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(row.project_id, member.user.tokenIdentifier, value, Date.now(), Date.now())
  }
  const input = {
    actor: { actorId: member.user.tokenIdentifier, actorKind: "human" as const },
    authority: { managed: true as const, workspaceId: "ws_current", orgId: row.org_id, role: "admin" as const },
    operation: "checkpoint_write" as const,
    minimumRole: "admin" as const,
  }
  return { authority, policy: embeddedManagedPrivateSessionPolicy(authority), input, role, directory }
}

test("checkpoint authority rechecks the current SQLite role instead of the role on the original request", async () => {
  const f = await fixture()
  f.role("admin")
  expect(await f.policy.authorizeHost!(f.input)).toEqual({ allowed: true })
  f.role("viewer")
  expect(await f.policy.authorizeHost!(f.input)).toMatchObject({ allowed: false, status: 403 })
  f.role("admin")
  expect(await f.policy.authorizeHost!(f.input)).toEqual({ allowed: true })
  f.role()
  expect(await f.policy.authorizeHost!(f.input)).toMatchObject({ allowed: false, status: 403 })
})

test("viewer streams receive renewable workspace leases and cannot reuse them across actors, workspaces or organizations", async () => {
  const f = await fixture()
  f.role("viewer")
  await expect(f.authority.resolveRuntimeMachineAccess(f.input.actor.actorId, "ws_current")).rejects.toMatchObject({ status: 403 })
  const input = { ...f.input, operation: "session_event_stream" as const, minimumRole: "viewer" as const }
  const first = await f.policy.authorizeHost!(input)
  if (!first.allowed || !first.lease) throw new Error("Expected a workspace stream lease")
  expect(await sessionStreamLeaseVerifier()(first.lease)).toMatchObject({ transport: "embedded", sessionId: "*", actorId: input.actor.actorId })
  expect(await f.policy.authorizeHost!({ ...input, lease: first.lease })).toMatchObject({ allowed: true })
  for (const altered of [
    { ...input, actor: { ...input.actor, actorId: "other" } },
    { ...input, authority: { ...input.authority, workspaceId: "other" } },
    { ...input, authority: { ...input.authority, orgId: "other" } },
  ]) expect(await f.policy.authorizeHost!({ ...altered, lease: first.lease })).toMatchObject({ allowed: false, status: 401 })
  f.role()
  expect(await f.policy.authorizeHost!({ ...input, lease: first.lease })).toMatchObject({ allowed: false, status: 403 })
})

test("an already-open SSE stream stops sessionless frames after current SQLite membership is revoked", async () => {
  const f = await fixture()
  f.role("viewer")
  const bus = createBus<WorkspaceRuntimeEvent>()
  const events = workspaceEventsHandler({
    directory: f.directory, workspaceId: "ws_current", eventHub: createRuntimeEventHub(), bus,
    sessionAccessPolicy: f.policy, policy: sessionEventDeliveryPolicy(f.policy),
    renewalIntervalMs: 60_000,
  })
  cleanup.push(() => events.close())
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("relayHostAuth" as never, {
      actor_id: f.input.actor.actorId, actor_kind: "human", org_id: f.input.authority.orgId,
      workspace_id: "ws_current", host_id: "host_local", role: "viewer",
    } as never)
    await next()
  })
  app.get("/api/wr/events", events)
  const abort = new AbortController()
  cleanup.push(() => abort.abort())
  const response = await app.request("http://localhost/api/wr/events", { signal: abort.signal })
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  const readUntil = async (marker: string) => {
    let text = ""
    for (let i = 0; i < 20; i++) {
      const next = await reader.read()
      if (next.done) return text
      text += new TextDecoder().decode(next.value)
      if (text.includes(marker)) return text
    }
    throw new Error("Expected stream marker")
  }
  bus.publish({ type: "process.status", directory: f.directory, configId: "before_revoke", status: "running" })
  expect(await readUntil("before_revoke")).toContain("before_revoke")
  f.role()
  const later = Date.now() + 6_000
  vi.spyOn(Date, "now").mockReturnValue(later)
  bus.publish({ type: "process.status", directory: f.directory, configId: "after_revoke", status: "running" })
  expect(await readUntil("after_revoke")).not.toContain("after_revoke")
  expect(await reader.read()).toMatchObject({ done: true })
})


test("checkpoint HTTP mutations reject a stale admin token after SQLite membership changes", async () => {
  const f = await fixture()
  const key = await generateKeyPair("EdDSA")
  const runtime = createWorkspaceRuntimeApp({
    exposure: relayWorkspaceRuntimeExposure({ workspaceId: "ws_current", hostId: "host_local", key: key.publicKey }),
    sessionAccessPolicy: f.policy,
  })
  try {
    const token = await new SignJWT({
      principal_kind: "user", actor_id: f.input.actor.actorId, actor_kind: "human",
      org_id: f.input.authority.orgId, workspace_id: "ws_current", host_id: "host_local",
      role: "admin", backing: "cloud-vm", parent_jti: "parent_checkpoint",
    }).setProtectedHeader({ alg: "EdDSA" }).setIssuer("workspace-relay").setAudience("workspace-host-service")
      .setIssuedAt().setExpirationTime("1m").setJti("stale_admin").sign(key.privateKey)
    const request = (operation: string) => runtime.app.request(`/api/wr/checkpoint/${operation}`, {
      method: "POST", headers: {
        authorization: `Bearer ${token}`, "content-type": "application/json",
        "x-workspace-id": "ws_current", "x-forwarded-by": "workspace-relay",
      }, body: JSON.stringify({ policy: "drain", epoch: 1, checkpointId: "checkpoint_1" }),
    })
    f.role("admin")
    expect((await request("freeze")).status).toBe(200)
    expect(runtime.host.checkpoint.detail().state).toBe("frozen")
    f.role("viewer")
    for (const operation of ["freeze", "flush", "scrub", "resume", "restore-reconcile"]) {
      expect((await request(operation)).status).toBe(403)
    }
    expect(runtime.host.checkpoint.detail().state).toBe("frozen")
    f.role("admin")
    expect((await request("resume")).status).toBe(200)
    expect(runtime.host.checkpoint.detail().state).toBe("active")
  } finally { await runtime.dispose() }
})
