import { describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { decodeJwt, exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { TASKS_ROUTE_PATH } from "@claxedo/tasks/http"
import type { TasksCapabilityOwner } from "@claxedo/server-core/tasks-host/capability"
import { mintMcpGatewayToken } from "../agent-plugins/mcp/runtime-token"
import { memorySandboxPassRegister } from "../platform/auth/sandbox-pass-register"
import { OWNER_GRANT_AUDIENCE, createOwnerGrantMinter, verifyOwnerGrant } from "../session/owner-grant"
import { mintTasksCapability, TASKS_CAPABILITY_AUDIENCE, verifyTasksCapability } from "./capability"
import { tasksGrantRenewalContribution, type TasksGrantRenewalAudit } from "./grant-renewal"
import { createTasksRootGrant, type TasksRootIdentity } from "./root-capability"

const RENEW = `${TASKS_ROUTE_PATH}/grant/renew`
const root: TasksRootIdentity = { userId: "alice", orgId: "org-1", projectId: "project-a", workspaceId: "ws_root", sessionId: "ses_1" }
const owner: TasksCapabilityOwner = { userId: "alice", actorId: "actor:alice", orgId: "org-1", projectId: "project-a" }

async function signingEnv() {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  return {
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
  }
}

async function fixture(options: {
  owner?: TasksCapabilityOwner | undefined
  tasksEnabled?: boolean
  subagentsEnabled?: boolean
  crossMachineWrites?: boolean
  now?: () => number
} = {}) {
  const env = await signingEnv()
  const passes = memorySandboxPassRegister(options.now ? { now: options.now } : {})
  const audit = vi.fn<(record: TasksGrantRenewalAudit) => void>()
  const workspaceOwner = vi.fn(async (workspaceId: string) =>
    workspaceId === root.workspaceId ? ("owner" in options ? options.owner : owner) : undefined,
  )
  const tasksGroupEnabled = vi.fn(async () => options.tasksEnabled ?? true)
  const subagentsGroupEnabled = vi.fn(async () => options.subagentsEnabled ?? false)
  const contribution = tasksGrantRenewalContribution({
    signingEnv: env,
    passes,
    workspaceOwner,
    tasksGroupEnabled,
    ownerGrant: { enabled: subagentsGroupEnabled, mint: createOwnerGrantMinter({ signingEnv: env, passes, ...(options.now ? { now: options.now } : {}) }) },
    grant: createTasksRootGrant({
      signingEnv: env,
      passes,
      crossMachineWrites: async () => options.crossMachineWrites ?? false,
      ...(options.now ? { now: options.now } : {}),
    }),
    audit,
    ...(options.now ? { now: options.now } : {}),
  })
  const app = new Hono().route(contribution.path, contribution.routes)
  const capability = (scope: Partial<TasksRootIdentity> = {}, minting: { now?: () => number; ttlSeconds?: number } = {}) =>
    mintTasksCapability({ ...root, ...scope, operations: ["read", "create"] }, env, { register: passes, ...minting })
  const renew = (token?: string) =>
    app.request(`https://core.test${RENEW}`, {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
  return { env, passes, app, audit, workspaceOwner, tasksGroupEnabled, subagentsGroupEnabled, capability, renew }
}

describe("the Tasks grant renewal route", () => {
  test("re-mints a still-valid capability for the same root and session, and the old token keeps working until its expiry", async () => {
    const { env, capability, renew, audit } = await fixture()
    const old = await capability()
    const response = await renew(old.token)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { token: string; operations: string[]; expiresAt: number }
    expect(body.operations).toEqual(["read", "create"])
    expect(body.expiresAt).toBe(decodeJwt(body.token).exp! * 1_000)
    expect(body.token).not.toBe(old.token)
    await expect(verifyTasksCapability(body.token, env)).resolves.toEqual({ ...root, operations: ["read", "create"] })
    await expect(verifyTasksCapability(old.token, env)).resolves.toMatchObject({ workspaceId: root.workspaceId })
    expect(audit).toHaveBeenCalledWith({
      workspaceId: root.workspaceId,
      owner: owner.actorId,
      orgId: root.orgId,
      projectId: root.projectId,
      sessionId: root.sessionId,
      operations: ["read", "create"],
      jti: decodeJwt(body.token).jti,
    })
  })

  test("carries a fresh owner grant beside the Tasks grant while the subagents group is on, from the one owner it resolved", async () => {
    const { env, passes, capability, renew, workspaceOwner, subagentsGroupEnabled, audit } = await fixture({ subagentsEnabled: true })
    const response = await renew((await capability()).token)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { token: string; ownerGrant?: { token: string; expiresAt: number } }
    expect(body.ownerGrant).toBeDefined()
    expect(body.ownerGrant!.expiresAt).toBe(decodeJwt(body.ownerGrant!.token).exp! * 1_000)
    await expect(verifyOwnerGrant(body.ownerGrant!.token, env, { revoked: passes.revoked })).resolves.toEqual({
      userId: owner.userId, actorId: owner.actorId, orgId: owner.orgId, projectId: owner.projectId, workspaceId: root.workspaceId,
    })
    expect(await passes.outstanding({ orgId: root.orgId, audience: OWNER_GRANT_AUDIENCE })).toMatchObject([{ jti: decodeJwt(body.ownerGrant!.token).jti }])
    expect(workspaceOwner).toHaveBeenCalledTimes(1)
    expect(subagentsGroupEnabled).toHaveBeenCalledWith(root)
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ ownerGrantJti: decodeJwt(body.ownerGrant!.token).jti }))
  })

  test("carries no owner grant while the subagents group is off, and none where the deployment mints none", async () => {
    const off = await fixture({ subagentsEnabled: false })
    const withoutSubagents = (await (await off.renew((await off.capability()).token)).json()) as Record<string, unknown>
    expect(withoutSubagents).not.toHaveProperty("ownerGrant")
    expect(await off.passes.outstanding({ orgId: root.orgId, audience: OWNER_GRANT_AUDIENCE })).toEqual([])
    expect(off.audit).toHaveBeenCalledWith(expect.not.objectContaining({ ownerGrantJti: expect.anything() }))

    const env = await signingEnv()
    const contribution = tasksGrantRenewalContribution({
      signingEnv: env,
      workspaceOwner: async () => owner,
      tasksGroupEnabled: async () => true,
      grant: createTasksRootGrant({ signingEnv: env }),
    })
    const app = new Hono().route(contribution.path, contribution.routes)
    const token = (await mintTasksCapability({ ...root, operations: ["read"] }, env)).token
    const renewed = await app.request(`https://core.test${RENEW}`, { method: "POST", headers: { authorization: `Bearer ${token}` } })
    expect(renewed.status).toBe(200)
    expect(await renewed.json()).not.toHaveProperty("ownerGrant")
  })

  test("the renewed token is written to the register and is refused once the workspace's passes are revoked", async () => {
    const { passes, capability, renew } = await fixture()
    const old = await capability()
    const renewed = (await (await renew(old.token)).json()) as { token: string }
    const outstanding = await passes.outstanding({ orgId: root.orgId, audience: TASKS_CAPABILITY_AUDIENCE })
    expect(new Set(outstanding.map((pass) => pass.jti))).toEqual(new Set([old.jti, decodeJwt(renewed.token).jti]))

    await passes.revoke({ workspaceId: root.workspaceId, audience: TASKS_CAPABILITY_AUDIENCE, reason: "tasks_group_disabled" })
    expect((await renew(renewed.token)).status).toBe(401)
    expect((await renew(old.token)).status).toBe(401)
  })

  test("follows the cross-machine reader: start appears when it says yes and disappears when it says no", async () => {
    const granted = await fixture({ crossMachineWrites: true })
    const withStart = (await (await granted.renew((await granted.capability()).token)).json()) as { operations: string[] }
    expect(withStart.operations).toEqual(["read", "create", "start"])

    const withheld = await fixture({ crossMachineWrites: false })
    const started = await mintTasksCapability({ ...root, operations: ["read", "create", "start"] }, withheld.env)
    const withoutStart = (await (await withheld.renew(started.token)).json()) as { operations: string[] }
    expect(withoutStart.operations).toEqual(["read", "create"])
  })

  test("refuses a missing, expired, foreign or tampered bearer as an invalid grant, never as a signed-route error", async () => {
    const start = 1_700_000_000_000
    const { env, capability, renew, workspaceOwner } = await fixture({ now: () => start + 10 * 60_000 })
    const expired = await capability({}, { now: () => start, ttlSeconds: 60 })
    const gateway = await mintMcpGatewayToken({
      userId: "alice", orgId: "org-1", projectId: "project-a", workspaceId: "ws_root", harnessId: "claude",
      pluginInstanceId: "plugin_1", serverName: "server", integrationId: "integration_1",
      artifactDigest: `sha256:${"a".repeat(64)}`, execution: "default",
    }, env)
    const other = await signingEnv()
    const foreign = await mintTasksCapability({ ...root, operations: ["read"] }, other)
    for (const bearer of [undefined, "alice", expired.token, gateway.token, foreign.token, `${(await capability()).token}x`]) {
      const response = await renew(bearer)
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: { code: "tasks_grant_invalid", message: expect.any(String) } })
    }
    expect(workspaceOwner).not.toHaveBeenCalled()
  })

  test("refuses when the workspace is gone or answers for someone else, and mints nothing", async () => {
    const gone = await fixture({ owner: undefined })
    const goneResponse = await gone.renew((await gone.capability()).token)
    expect(goneResponse.status).toBe(403)
    expect(await goneResponse.json()).toMatchObject({ error: { code: "tasks_grant_owner_changed" } })

    const reowned = await fixture({ owner: { ...owner, userId: "bob", actorId: "actor:bob" } })
    const reownedResponse = await reowned.renew((await reowned.capability()).token)
    expect(reownedResponse.status).toBe(403)
    expect(await reownedResponse.json()).toMatchObject({ error: { code: "tasks_grant_owner_changed" } })

    const moved = await fixture({ owner: { ...owner, projectId: "project-b" } })
    expect((await moved.renew((await moved.capability()).token)).status).toBe(403)

    for (const subject of [gone, reowned, moved]) {
      expect(subject.tasksGroupEnabled).not.toHaveBeenCalled()
      expect(subject.audit).not.toHaveBeenCalled()
      expect(await subject.passes.outstanding({ orgId: root.orgId, audience: TASKS_CAPABILITY_AUDIENCE })).toHaveLength(1)
    }
  })

  test("refuses once the project turned Tasks off, reading the activation as the workspace's owner", async () => {
    const { capability, renew, tasksGroupEnabled, audit } = await fixture({ tasksEnabled: false })
    const response = await renew((await capability()).token)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: { code: "tasks_group_disabled", message: "Tasks was turned off for this project." } })
    expect(tasksGroupEnabled).toHaveBeenCalledWith(root)
    expect(audit).not.toHaveBeenCalled()
  })

  test("a deployment without its verification key answers 503, not a withdrawal", async () => {
    const { capability } = await fixture()
    const contribution = tasksGrantRenewalContribution({
      signingEnv: {},
      workspaceOwner: async () => owner,
      tasksGroupEnabled: async () => true,
      grant: createTasksRootGrant({ signingEnv: {} }),
    })
    const app = new Hono().route(contribution.path, contribution.routes)
    const response = await app.request(`https://core.test${RENEW}`, {
      method: "POST",
      headers: { authorization: `Bearer ${(await capability()).token}` },
    })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: "tasks_capability_misconfigured" } })
  })
})
