import { afterEach, describe, expect, test, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { decodeJwt, exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { sessionStatusSnapshot } from "@claxedo/session-core"
import { openTestRuntimeStore } from "@claxedo/session-core/testing"
import type { SessionStatusChangedEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import type { ControlPlaneServices } from "../../authority/services"
import { HostSessionRowsRoutes } from "../../routes/hosted/host-session-rows"
import { publishD1HostSessionRows } from "../../authority/adapters/d1/host-session-rows"
import { createD1SandboxLeaseStore } from "../../sandbox/stores/d1"
import { memorySandboxPassRegister } from "../../platform/auth/sandbox-pass-register"
import { createSessionRowsPasses } from "../../session/session-rows-pass"
import { d1Authority } from "../../test-support/d1-authority"
import { cloudSessionRows, type CloudSessionRows } from "./cloud-session-rows"

const ROWS_URL = "https://core.test/api/claxedo/host/session-rows"
const DIRECTORY = "/workspace"
const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function plane() {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  const signingEnv = {
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
  }
  const fixture = await d1Authority()
  cleanup.push(fixture.dispose)
  const store = fixture.authority
  const owner = await fixture.signIn("owner")
  await store.usersMe(owner)
  await store.createCloudWorkspace(owner, { workspaceId: "ws_cloud", displayName: "Cloud" })
  await store.createCloudWorkspace(owner, { workspaceId: "ws_other", displayName: "Other" })
  const leases = createD1SandboxLeaseStore({ database: fixture.database })
  await leases.acquire("ws_cloud", { homeRegion: "us-east", driver: "test", staleAfterMs: 60_000 })
  const passes = createSessionRowsPasses({
    signingEnv,
    passes: memorySandboxPassRegister(),
    leases,
    workspaceOwner: async (workspaceId) => await store.resolveWorkspaceOwner?.(workspaceId),
  })
  const notices: SessionStatusChangedEvent[] = []
  const services = { relay: {}, authority: store } as unknown as ControlPlaneServices
  const app = new Hono().route("/api/claxedo/host/session-rows", HostSessionRowsRoutes(services, {
    notify: async (_orgId, delivered) => void notices.push(...delivered),
    sessionRowsPasses: passes,
  }))
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => await app.request(input, init)) as typeof globalThis.fetch
  const post = (token: string, body: { rows?: unknown[]; removed?: unknown[] }) => fetch(ROWS_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ hostId: "host-cloud", rows: [], removed: [], ...body }),
  })
  const sessionRow = (sessionId: string) => fixture.database
    .prepare("select workspace_id, status, awaiting_input from sessions where session_id = ?")
    .bind(sessionId)
    .first<{ workspace_id: string; status: string | null; awaiting_input: number | null }>()
  const launch = async () => {
    const lease = await leases.get("ws_cloud")
    return await passes.launchEnv({ workspaceId: "ws_cloud", epoch: lease!.epoch })
  }
  return { database: fixture.database, owner, leases, passes, notices, fetch, post, sessionRow, launch }
}

function runtimeStore() {
  const root = mkdtempSync(path.join(tmpdir(), "cloud-session-rows-"))
  const store = openTestRuntimeStore(root)
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  cleanup.push(() => store.close())
  store.bindSession({ owner: { kind: "machine-owner" }, sessionId: "ses_cloud", workspaceId: "ws_cloud", directory: DIRECTORY, title: "Fix the build", agentSessionId: "agent_cloud", createdAt: 1_000, updatedAt: 1_000 })
  return store
}

function bootRuntime(
  env: Record<string, string>,
  fetch: typeof globalThis.fetch,
  store: ReturnType<typeof runtimeStore>,
  now?: () => number,
): CloudSessionRows {
  const rows = cloudSessionRows({
    ...env,
    WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL: "https://core.test/api/runtime-authority/session-authorize",
    WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_cloud",
    WORKSPACE_RUNTIME_DIRECTORY: DIRECTORY,
    WORKSPACE_RUNTIME_HOST_ID: "host-cloud",
  }, { fetch, ...(now ? { now } : {}) })
  if (!rows) throw new Error("a launch with a session rows pass composes a publisher")
  cleanup.push(() => rows.stop())
  rows.bindSessionReads({ store: () => store, sessionStatus: (directory) => sessionStatusSnapshot(store.listSessions(directory)) })
  return rows
}

function busy(rows: CloudSessionRows) {
  rows.onPresentationEvent({ directory: DIRECTORY, payload: { id: "evt_busy", type: "session.status", properties: { sessionID: "ses_cloud", status: { type: "busy" } } } })
}

describe("a cloud runtime's session rows", () => {
  test("an unopened cloud session's status change reaches the session row and its owner's notice", async () => {
    const { owner, notices, fetch, sessionRow, launch } = await plane()
    const rows = bootRuntime(await launch(), fetch, runtimeStore())

    await vi.waitFor(async () => expect(await sessionRow("ses_cloud")).toMatchObject({ workspace_id: "ws_cloud", status: "idle" }), { timeout: 5_000 })
    busy(rows)

    await vi.waitFor(async () => expect(await sessionRow("ses_cloud")).toMatchObject({ status: "busy", awaiting_input: 0 }), { timeout: 5_000 })
    expect(notices).toContainEqual(expect.objectContaining({
      type: "session.status.changed",
      ownerUserId: owner.principal!.userId,
      sessionId: "ses_cloud",
      workspaceId: "ws_cloud",
      status: "busy",
    }))
  })

  test("a running runtime trades its pass at half its life and publishes with the fresh one", async () => {
    const { fetch, sessionRow, launch } = await plane()
    const env = await launch()
    const sent: Array<{ token: string; rows: number }> = []
    const recording = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { rows: unknown[] }
      sent.push({ token: new Headers(init?.headers).get("authorization")!.slice("Bearer ".length), rows: body.rows.length })
      return await fetch(input, init)
    }) as typeof globalThis.fetch
    const expiresAt = Number(decodeJwt(env.WORKSPACE_RUNTIME_SESSION_ROWS_PASS).exp) * 1_000
    const rows = bootRuntime(env, recording, runtimeStore(), () => expiresAt - 2_000)

    await vi.waitFor(() => expect(sent.some((call) => call.rows === 0)).toBe(true), { timeout: 5_000 })
    busy(rows)

    await vi.waitFor(async () => expect(await sessionRow("ses_cloud")).toMatchObject({ status: "busy" }), { timeout: 5_000 })
    const renewedPublish = sent.findLast((call) => call.rows > 0)!
    expect(renewedPublish.token).not.toBe(env.WORKSPACE_RUNTIME_SESSION_ROWS_PASS)
  })

  test("a pass whose lease epoch has ended is refused, for rows and for renewal alike", async () => {
    const { leases, post, sessionRow, launch } = await plane()
    const stale = (await launch()).WORKSPACE_RUNTIME_SESSION_ROWS_PASS
    const row = { workspaceId: "ws_cloud", sessionId: "ses_cloud", createdAt: 1, updatedAt: 2, status: { kind: "busy", awaitingInput: false, at: 3 } }

    await leases.acquire("ws_cloud", { homeRegion: "us-east", driver: "test", staleAfterMs: 0 })

    const refused = await post(stale, { rows: [row] })
    expect(refused.status).toBe(401)
    await expect(refused.json()).resolves.toMatchObject({ error: { code: "invalid_session_rows_pass" } })
    expect((await post(stale, {})).status).toBe(401)
    expect(await sessionRow("ses_cloud")).toBeNull()

    const current = (await launch()).WORKSPACE_RUNTIME_SESSION_ROWS_PASS
    await expect((await post(current, { rows: [row] })).json()).resolves.toEqual({ accepted: 1, refused: [] })
    expect(await sessionRow("ses_cloud")).toMatchObject({ status: "busy" })
  })

  test("a pass for one workspace publishes nothing for another workspace of the same owner", async () => {
    const { post, sessionRow, launch } = await plane()
    const pass = (await launch()).WORKSPACE_RUNTIME_SESSION_ROWS_PASS

    const response = await post(pass, {
      rows: [{ workspaceId: "ws_other", sessionId: "ses_elsewhere", createdAt: 1, updatedAt: 2, status: { kind: "busy", awaitingInput: false, at: 3 } }],
      removed: [{ workspaceId: "ws_other", sessionId: "ses_other_removed" }],
    })

    await expect(response.json()).resolves.toEqual({
      accepted: 0,
      refused: [
        { workspaceId: "ws_other", sessionId: "ses_elsewhere", reason: "workspace_not_served" },
        { workspaceId: "ws_other", sessionId: "ses_other_removed", reason: "workspace_not_served" },
      ],
    })
    expect(await sessionRow("ses_elsewhere")).toBeNull()
  })

  test("the cloud admission reads its lease and workspace by index, never by a scan", async () => {
    const { database, owner } = await plane()
    const reads: Array<{ sql: string; binds: unknown[] }> = []
    const recording = new Proxy(database, {
      get(target, property) {
        if (property !== "prepare") return Reflect.get(target, property).bind(target)
        return (sql: string) => {
          const statement = target.prepare(sql)
          return { bind: (...binds: unknown[]) => (reads.push({ sql, binds }), statement.bind(...binds)) }
        }
      },
    })
    await createD1SandboxLeaseStore({ database: recording }).get("ws_cloud")
    await publishD1HostSessionRows(recording, Date.now(), {
      hostId: "host-cloud", ownerUserId: owner.principal!.userId, workspaceIds: ["ws_cloud"], servedBy: "sandbox",
    }, { rows: [{ workspaceId: "ws_cloud", sessionId: "ses_planned", createdAt: 1, updatedAt: 2, status: { kind: "busy", awaitingInput: false, at: 3 } }], removed: [] })

    const admission = reads.filter((read) => /from (sandbox_leases|workspaces w)\b/.test(read.sql))
    expect(admission).toHaveLength(2)
    for (const read of admission) {
      const plan = await database.prepare(`explain query plan ${read.sql}`).bind(...read.binds).all<{ detail: string }>()
      expect(plan.results.map((step) => step.detail).filter((detail) => detail.startsWith("SCAN"))).toEqual([])
    }
  })

  test("an empty publication trades a live pass for a fresh one bound to the same epoch", async () => {
    const { leases, post, launch } = await plane()
    const pass = (await launch()).WORKSPACE_RUNTIME_SESSION_ROWS_PASS

    const response = await post(pass, {})
    const body = await response.json() as { credential: { token: string; expiresAt: number } }

    expect(response.status).toBe(200)
    expect(body.credential.token).not.toBe(pass)
    expect(decodeJwt(body.credential.token)).toMatchObject({ aud: "workspace-runtime-session-rows", workspace_id: "ws_cloud", lease_epoch: String((await leases.get("ws_cloud"))!.epoch) })
    expect((await post(body.credential.token, {})).status).toBe(200)
  })
})
