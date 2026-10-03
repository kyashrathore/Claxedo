import { afterEach, describe, expect, test, vi } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { CloudSessionRowsPublisher, CloudSessionRowsAuthority } from "@claxedo/server-core/platform/auth/cloud-session-rows"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { SessionAttentionFacts } from "@claxedo/agent-runtime-contract"
import { miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../../../test-support/control-plane-migrations"
import { D1WorkspaceAuthority } from "./workspace-authority"
import { D1SessionAuthority } from "./session-authority"
import { publishD1CloudSessionRows } from "./cloud-session-rows"
import { cloudSessionRowsPublisherActive } from "./cloud-session-rows-fence"
import { createCloudSessionRowsLaunchEnvironment } from "../../../session/cloud-session-rows-launch"
import { memorySandboxPassRegister } from "../../../platform/auth/sandbox-pass-register"
import { verifyCloudSessionRowsGrant } from "../../../session/cloud-session-rows-grant"
import { CloudSessionRowsRoutes } from "../../../routes/hosted/cloud-session-rows"
import { createD1SandboxPassRegister } from "../../../platform/auth/d1-sandbox-pass-register"
import type { ControlPlaneServices } from "../../../authority/services"
import type { ControlPlaneEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import type { D1PreparedStatement } from "@cloudflare/workers-types"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"

const active: ControlPlaneDatabase[] = []
afterEach(async () => { await Promise.all(active.splice(0).map((database) => database.dispose())) })

async function fixture() {
  const storage = await miniflareControlPlaneDatabase()
  active.push(storage)
  const database = storage.database
  let next = 0
  let clock = 1_800_000_000_000
  const now = () => clock
  const options = { deploymentId: "deployment-a", now, randomId: (prefix: string) => `${prefix}_${++next}` }
  const workspaces = new D1WorkspaceAuthority(database, { ...options, product: { kind: "claxedo-hosted" } })
  const identity = { adapter: "better-auth", issuer: "https://auth.example.test", subject: "alice" } as const
  const person = await workspaces.ensureApplicationIdentity(identity)
  if (person.state !== "active") throw new Error("test identity was not active")
  const auth: SignedControlPlaneAuth = { mode: "signed", principal: {
    userId: person.userId, actorId: person.actorId, actorKind: "human", deploymentId: "deployment-a",
    sessionId: "browser-alice", authenticatedAt: now(), methods: ["oauth:github"], assurance: "single-factor",
    client: { kind: "browser", tokenKind: "browser-session", id: "browser", resource: "https://api.example.test", scopes: ["openid"], origin: "https://app.example.test" }, identity,
  }, user: { subject: "alice", issuer: identity.issuer, tokenIdentifier: `${identity.issuer}|alice` } }
  await workspaces.createHostedOrganization(auth, { name: "Acme", orgId: "org_acme" })
  const workspace = await workspaces.createWorkspace(auth, { workspaceId: "ws_cloud", orgId: "org_acme", displayName: "Cloud", backing: "cloud-vm" })
  const sessions = new D1SessionAuthority(database, options)
  const register = async (sessionId: string, workspaceId = "ws_cloud") => {
    const operationId = `op_${sessionId}`
    await sessions.reserveSession(auth, { operationId, sessionId, workspaceId, kind: "create" })
    await sessions.registerRuntimeSession({ operationId, sessionId, workspaceId, principalKind: "user", actorId: person.actorId, actorKind: "human", createdAt: 1, updatedAt: 1 })
  }
  await register("ses_cloud")
  await database.prepare(`INSERT INTO sandbox_leases (workspace_id,lease_id,epoch,status,driver,created_at,updated_at) VALUES ('ws_cloud','host_cloud',7,'ready','cloudflare',1,1)`).run()
  const publisher: CloudSessionRowsPublisher = { workspaceId: "ws_cloud", hostId: "host_cloud", epoch: 7, userId: person.userId, actorId: person.actorId, orgId: "org_acme", projectId: workspace.project_id }
  const facts: SessionAttentionFacts = { generation: 1, sequence: 10, activitySequence: 9, activityAt: 9, outcome: { sequence: 9, completedAt: 9, status: "completed" }, working: false, awaitingInput: false }
  const row = { workspaceId: "ws_cloud", sessionId: "ses_cloud", title: "Cloud result", createdAt: 1, updatedAt: 9, status: { kind: "idle" as const, awaitingInput: false, at: 9 }, attention: facts, lastTurn: { status: "completed" as const, completedAt: 9, assistantMessageId: "msg_result" } }
  const attention = { workspaceId: "ws_cloud", sessionId: "ses_cloud", generation: 1, through: 10, events: [{ kind: "outcome" as const, sequence: 9, openedAt: 9, outcome: "completed" as const }] }
  return { database, now, publisher, row, attention, register, workspaces, auth, person, sessions, advance: (milliseconds = 60 * 60_000) => { clock += milliseconds } }
}

describe("D1 cloud session row publication", () => {
  test("replacement after the admission read aborts the entire publication batch", async () => {
    const input = await fixture()
    const batch = input.database.batch.bind(input.database)
    const intercepted = vi.fn(async (statements: D1PreparedStatement[]) => {
      await input.database.prepare("UPDATE sandbox_leases SET epoch=8 WHERE workspace_id='ws_cloud'").run()
      return batch(statements)
    })
    const raced = new Proxy(input.database, { get: (target, name) => name === "batch" ? intercepted : Reflect.get(target, name) })
    await expect(publishD1CloudSessionRows(raced, input.now(), input.publisher, {
      rows: [input.row], removed: [], attention: [input.attention],
    })).rejects.toMatchObject({ status: 403 })
    expect(intercepted).toHaveBeenCalledTimes(1)
    expect(await input.database.prepare("SELECT title,attention_json FROM sessions WHERE session_id='ses_cloud'").first()).toEqual({ title: null, attention_json: null })
    expect(await input.database.prepare("SELECT COUNT(*) AS count FROM session_attention_events").first()).toEqual({ count: 0 })
  })
  test("publishes through the public proof route, fans out private notices, and recovers after expiry", async () => {
    const input = await fixture()
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const signingEnv = { CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey), CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey) }
    const passes = createD1SandboxPassRegister({ database: input.database, now: input.now })
    const launch = createCloudSessionRowsLaunchEnvironment({ database: input.database, deploymentId: "deployment-a", signingEnv, passes, now: input.now, controlPlaneOrigin: "https://api.example.test" })
    const env = await launch({ workspaceId: "ws_cloud", homeRegion: "us-east", epoch: 7, labels: {} }, { id: "host_cloud" })
    const notices: ControlPlaneEvent[] = []
    const authority: CloudSessionRowsAuthority & Pick<WorkspaceAuthority, "sessionPublicationNotices"> = {
      publishCloudSessionRows: (publisher, publication) => publishD1CloudSessionRows(input.database, input.now(), publisher, publication),
      cloudSessionRowsPublisherActive: (publisher) => cloudSessionRowsPublisherActive(input.database, publisher),
      sessionPublicationNotices: input.sessions.sessionPublicationNotices.bind(input.sessions),
    }
    const app = CloudSessionRowsRoutes({ authority } as unknown as ControlPlaneServices,
      { signingEnv, passes, now: input.now, notice: async (event) => { notices.push(event) } })
    const post = (path: string, token: string) => app.request(path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ rows: [input.row], removed: [], attention: [input.attention] }) })
    const token = env.WORKSPACE_RUNTIME_SESSION_ROWS_TOKEN
    expect(await (await post("/", token)).json()).toEqual({ accepted: 2, refused: [] })
    expect(notices.some((event) => "ownerUserId" in event && event.ownerUserId === input.person.userId)).toBe(true)
    input.advance()
    expect((await post("/", token)).status).toBe(401)
    const renewed = await (await post("/renew", token)).json() as { token: string }
    expect(await (await post("/", renewed.token)).json()).toEqual({ accepted: 2, refused: [] })
    await input.database.prepare("UPDATE sandbox_leases SET epoch=8 WHERE workspace_id='ws_cloud'").run()
    expect((await post("/renew", renewed.token)).status).toBe(403)
  })
  test("persists rows and durable history idempotently without adopting sandbox-selected ids", async () => {
    const input = await fixture()
    const publication = { rows: [input.row], removed: [], attention: [input.attention] }
    await expect(publishD1CloudSessionRows(input.database, input.now(), input.publisher, publication)).resolves.toEqual({ accepted: 2, refused: [] })
    await publishD1CloudSessionRows(input.database, input.now(), input.publisher, publication)
    expect(await input.database.prepare("SELECT title,attention_json,last_turn_json,runtime_host_id,runtime_generation,runtime_enrollment_id FROM sessions WHERE session_id='ses_cloud'").first()).toMatchObject({ title: "Cloud result", attention_json: JSON.stringify(input.row.attention), last_turn_json: JSON.stringify(input.row.lastTurn), runtime_host_id: "host_cloud", runtime_generation: 7, runtime_enrollment_id: null })
    expect(await input.database.prepare("SELECT COUNT(*) AS count FROM session_attention_events").first()).toEqual({ count: 1 })
    const unknown = { ...input.row, sessionId: "ses_invented" }
    await expect(publishD1CloudSessionRows(input.database, input.now(), input.publisher, { rows: [unknown], removed: [] })).resolves.toMatchObject({ accepted: 0, refused: [{ sessionId: "ses_invented", reason: "session_unregistered" }] })
    expect(await input.database.prepare("SELECT 1 FROM sessions WHERE session_id='ses_invented'").first()).toBeNull()
  })
  test("a failed public removal notice is retried with the original committed tombstone", async () => {
    const input = await fixture()
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const signingEnv = { CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey), CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey) }
    const passes = createD1SandboxPassRegister({ database: input.database, now: input.now })
    const launch = createCloudSessionRowsLaunchEnvironment({ database: input.database, deploymentId: "deployment-a", signingEnv, passes, now: input.now, controlPlaneOrigin: "https://api.example.test" })
    const env = await launch({ workspaceId: "ws_cloud", homeRegion: "us-east", epoch: 7, labels: {} }, { id: "host_cloud" })
    const notices: ControlPlaneEvent[] = []
    let deliveryAttempts = 0
    const authority: CloudSessionRowsAuthority & Pick<WorkspaceAuthority, "sessionPublicationNotices"> = {
      publishCloudSessionRows: (publisher, publication) => publishD1CloudSessionRows(input.database, input.now(), publisher, publication),
      cloudSessionRowsPublisherActive: (publisher) => cloudSessionRowsPublisherActive(input.database, publisher),
      sessionPublicationNotices: input.sessions.sessionPublicationNotices.bind(input.sessions),
    }
    const app = CloudSessionRowsRoutes({ authority } as unknown as ControlPlaneServices,
      { signingEnv, passes, now: input.now, notice: async (event) => {
        if (++deliveryAttempts === 1) throw new Error("Private notice delivery failed")
        notices.push(event)
      } })
    const post = () => app.request("/", { method: "POST", headers: {
      authorization: `Bearer ${env.WORKSPACE_RUNTIME_SESSION_ROWS_TOKEN}`, "content-type": "application/json",
    }, body: JSON.stringify({ rows: [], removed: [{ workspaceId: "ws_cloud", sessionId: "ses_cloud" }] }) })
    const deletedAt = input.now()
    expect((await post()).status).toBe(500)
    expect(notices).toEqual([])
    expect(await input.database.prepare("SELECT deleted_at FROM sessions WHERE session_id='ses_cloud'").first()).toEqual({ deleted_at: deletedAt })
    input.advance(1_000)
    const response = await post()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ accepted: 1, refused: [] })
    expect(deliveryAttempts).toBe(2)
    expect(notices).toEqual([{
      type: "session.removed", ownerUserId: input.person.userId, sessionId: "ses_cloud",
      workspaceId: "ws_cloud", orgId: "org_acme", projectId: input.publisher.projectId, ts: deletedAt,
    }])
    expect(await input.database.prepare("SELECT deleted_at FROM sessions WHERE session_id='ses_cloud'").first()).toEqual({ deleted_at: deletedAt })
  })
  test("rejects a stale host, replacement epoch, retired workspace, or revoked owner", async () => {
    const input = await fixture()
    for (const publisher of [{ ...input.publisher, hostId: "stale-host" }, { ...input.publisher, epoch: 6 }]) {
      await expect(cloudSessionRowsPublisherActive(input.database, publisher)).resolves.toBe(false)
      await expect(publishD1CloudSessionRows(input.database, input.now(), publisher, { rows: [input.row], removed: [] })).resolves.toMatchObject({ accepted: 0, refused: [{ reason: "workspace_not_served" }] })
    }
    await input.database.prepare("UPDATE users SET state='suspended',suspended_at=2 WHERE user_id=?").bind(input.person.userId).run()
    await expect(cloudSessionRowsPublisherActive(input.database, input.publisher)).resolves.toBe(false)
    await input.database.prepare("UPDATE users SET state='active',suspended_at=NULL WHERE user_id=?").bind(input.person.userId).run()
    const replacement = await input.workspaces.ensureApplicationIdentity({ adapter: "better-auth", issuer: "https://auth.example.test", subject: "bob" })
    if (replacement.state !== "active") throw new Error("replacement owner was not active")
    await input.database.prepare("UPDATE workspaces SET owner_user_id=? WHERE workspace_id='ws_cloud'").bind(replacement.userId).run()
    await expect(cloudSessionRowsPublisherActive(input.database, input.publisher)).resolves.toBe(false)
    await input.database.prepare("UPDATE workspaces SET owner_user_id=? WHERE workspace_id='ws_cloud'").bind(input.person.userId).run()
    await input.database.prepare("UPDATE workspaces SET deleted_at=2 WHERE workspace_id='ws_cloud'").run()
    await expect(cloudSessionRowsPublisherActive(input.database, input.publisher)).resolves.toBe(false)
  })
  test("refuses foreign, deleted, and incompatible attention generations", async () => {
    const input = await fixture()
    const foreign = await input.workspaces.createWorkspace(input.auth, { workspaceId: "ws_other", orgId: "org_acme", displayName: "Other", backing: "cloud-vm" })
    await input.register("ses_foreign", foreign.workspace_id)
    await expect(publishD1CloudSessionRows(input.database, input.now(), input.publisher, {
      rows: [{ ...input.row, sessionId: "ses_foreign" }], removed: [],
    })).resolves.toMatchObject({ accepted: 0, refused: [{ reason: "session_elsewhere" }] })
    await expect(publishD1CloudSessionRows(input.database, input.now(), input.publisher, {
      rows: [input.row], removed: [], attention: [{ ...input.attention, generation: 2 }],
    })).resolves.toMatchObject({ accepted: 0, refused: [{ reason: "attention_boundary_changed" }, { reason: "attention_boundary_changed" }] })
    await input.database.prepare("UPDATE sessions SET deleted_at=2 WHERE session_id='ses_cloud'").run()
    await expect(publishD1CloudSessionRows(input.database, input.now(), input.publisher, { rows: [input.row], removed: [] })).resolves.toMatchObject({ accepted: 0, refused: [{ reason: "session_deleted" }] })
    const removed = [{ workspaceId: "ws_cloud", sessionId: "ses_cloud" }]
    await expect(publishD1CloudSessionRows(input.database, input.now(), input.publisher, { rows: [input.row], removed, attention: [input.attention] }))
      .resolves.toMatchObject({ accepted: 0, refused: [{ reason: "session_deleted" }, { reason: "session_deleted" }, { reason: "session_deleted" }] })
    await expect(publishD1CloudSessionRows(input.database, input.now(), input.publisher, { rows: [], removed, attention: [input.attention] }))
      .resolves.toMatchObject({ accepted: 0, refused: [{ reason: "session_deleted" }, { reason: "session_deleted" }] })
    await expect(publishD1CloudSessionRows(input.database, input.now(), { ...input.publisher, epoch: 6 }, { rows: [], removed }))
      .resolves.toMatchObject({ accepted: 0, refused: [{ reason: "workspace_not_served" }] })
    expect(await input.database.prepare("SELECT title,deleted_at,attention_json FROM sessions WHERE session_id='ses_cloud'").first())
      .toEqual({ title: null, deleted_at: 2, attention_json: null })
  })
  test("mints the launch environment from canonical owner and exact driver lease", async () => {
    const input = await fixture()
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const signingEnv = { CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey), CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey) }
    const passes = memorySandboxPassRegister({ now: input.now })
    const launch = createCloudSessionRowsLaunchEnvironment({ database: input.database, deploymentId: "deployment-a", signingEnv, passes, now: input.now, controlPlaneOrigin: "https://api.example.test/" })
    const env = await launch({ workspaceId: "ws_cloud", homeRegion: "us-east", epoch: 7, labels: {} }, { id: "host_cloud" })
    expect(env.WORKSPACE_RUNTIME_SESSION_ROWS_URL).toBe("https://api.example.test/api/claxedo/cloud/session-rows")
    await expect(verifyCloudSessionRowsGrant(env.WORKSPACE_RUNTIME_SESSION_ROWS_TOKEN, signingEnv, { passes, now: input.now })).resolves.toEqual(input.publisher)
  })
})
