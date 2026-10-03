import { afterEach, describe, expect, test, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { decodeJwt, exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import type { BackgroundWork } from "@claxedo/agent-runtime-contract"
import { sessionStatusSnapshot } from "@claxedo/session-core"
import { openTestRuntimeStore } from "@claxedo/session-core/testing"
import type { RelayHostAuthContext } from "@claxedo/workspace-runtime/relay"
import type { WorkspaceRuntimeRouteContext } from "@claxedo/workspace-runtime/route-contribution"
import { SESSION_ROWS_PASS_PATH } from "@claxedo/server-core/hosts/workspace-runtime/env"
import type { SessionStatusChangedEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import type { ControlPlaneServices } from "../../authority/services"
import { HostSessionRowsRoutes } from "../../routes/hosted/host-session-rows"
import { publishD1HostSessionRows } from "../../authority/adapters/d1/host-session-rows"
import { createD1SandboxLeaseStore } from "../../sandbox/stores/d1"
import { memorySandboxPassRegister } from "../../platform/auth/sandbox-pass-register"
import { SANDBOX_PASS_DEFAULT_TTL_SECONDS } from "../../platform/auth/sandbox-pass"
import { createSessionRowsPasses } from "../../session/session-rows-pass"
import { d1Authority } from "../../test-support/d1-authority"
import { cloudSessionRows, type CloudSessionRows } from "./cloud-session-rows"

const ROWS_URL = "https://core.test/api/claxedo/host/session-rows"
const DIRECTORY = "/workspace"
const WORKTREE = "/home/claxedo/workspaces/ws_cloud/worktrees/ses_tree"
const CONTROL_PLANE_CALLER = { principal_kind: "service", actor_id: "control-plane" }
const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

type Runtime = { rows: CloudSessionRows; relay: Hono<{ Variables: RelayHostAuthContext }> }

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
  const other = await fixture.signIn("other")
  const { org_id: orgId } = await store.usersMe(owner) as { org_id: string }
  await store.usersMe(other)
  await fixture.addMember(owner, other, orgId)
  await store.createCloudWorkspace(owner, { workspaceId: "ws_cloud", displayName: "Cloud" })
  await store.createCloudWorkspace(owner, { workspaceId: "ws_other", displayName: "Other" })
  const leases = createD1SandboxLeaseStore({ database: fixture.database })
  const serve = async (workspaceId = "ws_cloud") => {
    const held = await leases.get(workspaceId)
    if (held) await leases.update(workspaceId, held.epoch, { status: "stopped" })
    const { lease } = await leases.acquire(workspaceId, { homeRegion: "us-east", driver: "test", staleAfterMs: 0 })
    await leases.recordTarget(workspaceId, lease.epoch, { sandboxId: `sb_${workspaceId}`, url: "https://sandbox.test", hostId: "host-cloud", labels: {} })
    return lease.epoch
  }
  await serve()
  const register = memorySandboxPassRegister()
  const minted: string[] = []
  const recording = { ...register, record: async (pass: Parameters<typeof register.record>[0]) => (minted.push(pass.jti), await register.record(pass)) }
  let clock: number | undefined
  let runtime: Runtime | undefined
  const delivered: string[] = []
  const passes = createSessionRowsPasses({
    signingEnv,
    passes: recording,
    leases,
    workspaceOwner: async (workspaceId) => await store.resolveWorkspaceOwner?.(workspaceId),
    runtimeFetch: async (_workspaceId, _orgId, requestPath, init) => {
      if (runtime) return await runtime.relay.request(requestPath, init)
      if (init.method === "GET") return Response.json({ held: null })
      delivered.push((JSON.parse(init.body as string) as { token: string }).token)
      return new Response(null, { status: 204 })
    },
    now: () => clock ?? Date.now(),
  })
  const notices: SessionStatusChangedEvent[] = []
  const services = { relay: {}, authority: store } as unknown as ControlPlaneServices
  const app = new Hono().route("/api/claxedo/host/session-rows", HostSessionRowsRoutes(services, {
    notify: async (_orgId, sent) => void notices.push(...sent),
    sessionRowsPasses: passes,
  }))
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => await app.request(input, init)) as typeof globalThis.fetch
  const post = (token: string, body: { rows?: unknown[]; removed?: unknown[] }) => fetch(ROWS_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ hostId: "host-cloud", rows: [], removed: [], ...body }),
  })
  const sessionRow = (sessionId: string) => fixture.database
    .prepare("select workspace_id, status, awaiting_input, background_agents from sessions where session_id = ?")
    .bind(sessionId)
    .first<{ workspace_id: string; status: string | null; awaiting_input: number | null; background_agents: number | null }>()
  const issue = async (workspaceId = "ws_cloud") => {
    await passes.deliver(workspaceId)
    return delivered.at(-1)!
  }
  return {
    database: fixture.database, owner, other, leases, passes, notices, fetch, post, sessionRow, serve, issue, minted,
    setClock: (at: number | undefined) => { clock = at },
    attach: (next: Runtime) => { runtime = next },
  }
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
  fetch: typeof globalThis.fetch,
  store: ReturnType<typeof runtimeStore>,
  options: { now?: () => number; backgroundWork?: (sessionId: string) => BackgroundWork | undefined; caller?: object } = {},
): Runtime {
  const rows = cloudSessionRows({
    WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL: "https://core.test/api/runtime-authority/session-authorize",
    WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_cloud",
    WORKSPACE_RUNTIME_DIRECTORY: DIRECTORY,
    WORKSPACE_RUNTIME_HOST_ID: "host-cloud",
  }, { fetch, ...(options.now ? { now: options.now } : {}) })
  if (!rows) throw new Error("a runtime that knows its control plane composes a publisher")
  cleanup.push(() => rows.stop())
  rows.bindSessionReads({ store: () => store, sessionStatus: () => sessionStatusSnapshot(store.listEverySession(), options.backgroundWork) })
  const relay = new Hono<{ Variables: RelayHostAuthContext }>()
  relay.use("*", async (c, next) => {
    c.set("relayHostAuth", (options.caller ?? CONTROL_PLANE_CALLER) as RelayHostAuthContext["relayHostAuth"])
    await next()
  })
  relay.route("/", rows.routes.mount({} as WorkspaceRuntimeRouteContext).routes)
  return { rows, relay }
}

function busy(rows: CloudSessionRows) {
  rows.onPresentationEvent({ directory: DIRECTORY, payload: { id: "evt_busy", type: "session.status", properties: { sessionID: "ses_cloud", status: { type: "busy" } } } })
}

const row = (workspaceId: string, sessionId: string) =>
  ({ workspaceId, sessionId, createdAt: 1, updatedAt: 2, status: { kind: "busy" as const, awaitingInput: false, at: 3 } })

describe("a cloud runtime's session rows", () => {
  test("an unopened cloud session's status change reaches the session row and its owner's notice once the plane delivers a pass", async () => {
    const { owner, notices, fetch, sessionRow, passes, attach } = await plane()
    const runtime = bootRuntime(fetch, runtimeStore())
    attach(runtime)

    await passes.deliver("ws_cloud")
    await vi.waitFor(async () => expect(await sessionRow("ses_cloud")).toMatchObject({ workspace_id: "ws_cloud", status: "idle" }), { timeout: 5_000 })
    busy(runtime.rows)

    await vi.waitFor(async () => expect(await sessionRow("ses_cloud")).toMatchObject({ status: "busy", awaiting_input: 0 }), { timeout: 5_000 })
    expect(notices).toContainEqual(expect.objectContaining({
      type: "session.status.changed", ownerUserId: owner.principal!.userId, sessionId: "ses_cloud", workspaceId: "ws_cloud", status: "busy",
    }))
  })

  test("after an epoch move a reused runtime is handed a pass for the new epoch and keeps publishing", async () => {
    const { fetch, sessionRow, passes, attach, serve, leases } = await plane()
    const runtime = bootRuntime(fetch, runtimeStore())
    attach(runtime)
    await passes.deliver("ws_cloud")
    await vi.waitFor(async () => expect(await sessionRow("ses_cloud")).toMatchObject({ status: "idle" }), { timeout: 5_000 })

    const epoch = await serve()
    await passes.deliver("ws_cloud")
    busy(runtime.rows)

    await vi.waitFor(async () => expect(await sessionRow("ses_cloud")).toMatchObject({ status: "busy" }), { timeout: 5_000 })
    const held = await (await runtime.relay.request(SESSION_ROWS_PASS_PATH)).json() as { held: { epoch: number } }
    expect(held.held.epoch).toBe(epoch)
    expect((await leases.get("ws_cloud"))?.epoch).toBe(epoch)
  })

  test("a delivery mints nothing while the runtime's pass is for the current epoch and not yet due", async () => {
    const { fetch, passes, attach, minted } = await plane()
    attach(bootRuntime(fetch, runtimeStore()))

    await passes.deliver("ws_cloud")
    await passes.deliver("ws_cloud")

    expect(minted).toHaveLength(1)
  })

  test("only the control plane hands a runtime its pass", async () => {
    const { fetch, issue } = await plane()
    const runtime = bootRuntime(fetch, runtimeStore(), { caller: { principal_kind: "user", actor_id: "act_reader" } })
    const pass = await issue()

    const put = await runtime.relay.request(SESSION_ROWS_PASS_PATH, { method: "PUT", body: JSON.stringify({ token: pass }) })

    expect(put.status).toBe(403)
    expect((await runtime.relay.request(SESSION_ROWS_PASS_PATH)).status).toBe(403)
  })

  test("a running runtime trades its pass at half its life and publishes with the fresh one", async () => {
    const { fetch, sessionRow, passes, attach, setClock } = await plane()
    const sent: Array<{ token: string; rows: number }> = []
    const recording = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { rows: unknown[] }
      sent.push({ token: new Headers(init?.headers).get("authorization")!.slice("Bearer ".length), rows: body.rows.length })
      return await fetch(input, init)
    }) as typeof globalThis.fetch
    const runtime = bootRuntime(recording, runtimeStore(), { now: () => Date.now() + SANDBOX_PASS_DEFAULT_TTL_SECONDS * 1_000 - 2_000 })
    attach(runtime)
    await passes.deliver("ws_cloud")
    const first = await (await runtime.relay.request(SESSION_ROWS_PASS_PATH)).json() as { held: { issuedAt: number; expiresAt: number } }
    setClock((first.held.issuedAt + first.held.expiresAt) / 2 + 1)

    await vi.waitFor(() => expect(sent.some((call) => call.rows === 0)).toBe(true), { timeout: 5_000 })
    busy(runtime.rows)

    await vi.waitFor(async () => expect(await sessionRow("ses_cloud")).toMatchObject({ status: "busy" }), { timeout: 5_000 })
    expect(sent.findLast((call) => call.rows > 0)!.token).not.toBe(sent.find((call) => call.rows === 0)!.token)
  }, 20_000)

  test("a renewal before half the pass's life is refused, and a renewal revokes the pass it replaced", async () => {
    const { post, issue, setClock } = await plane()
    const pass = await issue()
    const claims = decodeJwt(pass)

    const early = await post(pass, {})
    expect(early.status).toBe(409)
    await expect(early.json()).resolves.toMatchObject({ error: { code: "session_rows_pass_not_due" } })

    setClock((claims.iat! + (claims.exp! - claims.iat!) / 2) * 1_000 + 1)
    const renewed = await post(pass, {})
    expect(renewed.status).toBe(200)
    const { credential } = await renewed.json() as { credential: { token: string } }
    expect(decodeJwt(credential.token)).toMatchObject({ aud: "workspace-runtime-session-rows", workspace_id: "ws_cloud" })

    const replaced = await post(pass, { rows: [row("ws_cloud", "ses_cloud")] })
    expect(replaced.status).toBe(401)
    expect((await post(credential.token, { rows: [row("ws_cloud", "ses_cloud")] })).status).toBe(200)
  })

  test("a full republish carries every session of the workspace, one filed under its worktree with its open permission included", async () => {
    const { fetch, sessionRow, passes, attach } = await plane()
    const store = runtimeStore()
    store.bindSession({ owner: { kind: "machine-owner" }, sessionId: "ses_tree", workspaceId: "ws_cloud", directory: WORKTREE, title: "In a worktree", agentSessionId: "agent_tree", createdAt: 1_000, updatedAt: 1_000 })
    store.appendEvent({ sessionId: "ses_tree", payload: { id: "evt_ask", type: "permission.asked", properties: { id: "per_tree", sessionID: "ses_tree", permission: "bash", patterns: ["ls"], always: [], metadata: {} } } })
    attach(bootRuntime(fetch, store))

    await passes.deliver("ws_cloud")

    await vi.waitFor(async () => expect(await sessionRow("ses_tree")).toMatchObject({ workspace_id: "ws_cloud", awaiting_input: 1 }), { timeout: 5_000 })
    expect(await sessionRow("ses_cloud")).toMatchObject({ workspace_id: "ws_cloud", awaiting_input: 0 })
  })

  test("a full republish keeps a session's running background work", async () => {
    const { fetch, sessionRow, passes, attach } = await plane()
    const running = { agents: 2, shells: 0, other: 0 }
    attach(bootRuntime(fetch, runtimeStore(), { backgroundWork: (sessionId) => (sessionId === "ses_cloud" ? running : undefined) }))

    await passes.deliver("ws_cloud")

    await vi.waitFor(async () => expect(await sessionRow("ses_cloud")).toMatchObject({ status: "idle", background_agents: 2 }), { timeout: 5_000 })
  })

  test("closing the store first publishes the sessions' final status", async () => {
    const { fetch, sessionRow, passes, attach } = await plane()
    const runtime = bootRuntime(fetch, runtimeStore())
    attach(runtime)
    await passes.deliver("ws_cloud")
    await vi.waitFor(async () => expect(await sessionRow("ses_cloud")).toMatchObject({ status: "idle" }), { timeout: 5_000 })

    busy(runtime.rows)
    await runtime.rows.beforeStoreClose()

    expect(await sessionRow("ses_cloud")).toMatchObject({ status: "busy" })
  })
})

describe("the session rows pass at the door", () => {
  test("a pass whose lease epoch has ended is refused, for rows and for renewal alike", async () => {
    const { serve, post, sessionRow, issue } = await plane()
    const stale = await issue()

    await serve()

    const refused = await post(stale, { rows: [row("ws_cloud", "ses_cloud")] })
    expect(refused.status).toBe(401)
    await expect(refused.json()).resolves.toMatchObject({ error: { code: "invalid_session_rows_pass" } })
    expect((await post(stale, {})).status).toBe(401)
    expect(await sessionRow("ses_cloud")).toBeNull()
    expect((await post(await issue(), { rows: [row("ws_cloud", "ses_cloud")] })).status).toBe(200)
  })

  test("a pass for a lease that stopped serving is refused", async () => {
    const { leases, post, issue } = await plane()
    const pass = await issue()
    const lease = (await leases.get("ws_cloud"))!

    await leases.update("ws_cloud", lease.epoch, { status: "stopped" })

    expect((await post(pass, { rows: [row("ws_cloud", "ses_cloud")] })).status).toBe(401)
  })

  test("a pass whose user no longer owns the workspace is refused, for rows and for renewal alike", async () => {
    const { database, other, passes, post, issue, setClock } = await plane()
    const pass = await issue()
    const claims = decodeJwt(pass)
    setClock((claims.iat! + (claims.exp! - claims.iat!) / 2) * 1_000 + 1)

    await database.prepare("update workspaces set owner_user_id = ? where workspace_id = ?").bind(other.principal!.userId, "ws_cloud").run()

    expect((await post(pass, { rows: [row("ws_cloud", "ses_cloud")] })).status).toBe(401)
    expect((await post(pass, {})).status).toBe(401)
    await expect(passes.admit(await issue(), "host-cloud"), "the new owner is one the authority resolves").resolves.toMatchObject({ ownerUserId: other.principal!.userId })
  })

  test("a pass for one workspace publishes nothing for another workspace of the same owner", async () => {
    const { post, sessionRow, issue } = await plane()
    const pass = await issue()

    const response = await post(pass, { rows: [row("ws_other", "ses_elsewhere")], removed: [{ workspaceId: "ws_other", sessionId: "ses_other_removed" }] })

    await expect(response.json()).resolves.toEqual({
      accepted: 0,
      refused: [
        { workspaceId: "ws_other", sessionId: "ses_elsewhere", reason: "workspace_not_served" },
        { workspaceId: "ws_other", sessionId: "ses_other_removed", reason: "workspace_not_served" },
      ],
    })
    expect(await sessionRow("ses_elsewhere")).toBeNull()
  })

  test("a session registered to another workspace is not moved by a cloud runtime's row", async () => {
    const { database, owner, post, sessionRow, issue } = await plane()
    await publishD1HostSessionRows(database, Date.now(), {
      hostId: "host-other", ownerUserId: owner.principal!.userId, workspaceIds: ["ws_other"], servedBy: "sandbox",
    }, { rows: [row("ws_other", "ses_shared_id")], removed: [] })

    const response = await post(await issue(), { rows: [row("ws_cloud", "ses_shared_id")] })

    await expect(response.json()).resolves.toEqual({ accepted: 0, refused: [{ workspaceId: "ws_cloud", sessionId: "ses_shared_id", reason: "session_elsewhere" }] })
    expect(await sessionRow("ses_shared_id")).toMatchObject({ workspace_id: "ws_other" })
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
    }, { rows: [row("ws_cloud", "ses_planned")], removed: [] })

    const admission = reads.filter((read) => /from (sandbox_leases|workspaces w)\b/.test(read.sql))
    expect(admission).toHaveLength(2)
    for (const read of admission) {
      const plan = await database.prepare(`explain query plan ${read.sql}`).bind(...read.binds).all<{ detail: string }>()
      expect(plan.results.map((step) => step.detail).filter((detail) => detail.startsWith("SCAN"))).toEqual([])
    }
  })
})
