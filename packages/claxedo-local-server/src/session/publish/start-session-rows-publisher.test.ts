import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { onHostServingCredential, stopHostServing } from "@claxedo/host-serving/serving"
import type { HostSessionRow, SessionAttentionPublication } from "@claxedo/server-core/platform/auth/host-session-rows"
import { connectionIdForHarness, type SessionRef } from "@claxedo/agent-runtime-contract"
import { ensureWorkspace } from "@claxedo/server-core/workspace/store/index"
import { ensureEmbeddedWorkspaceRuntime } from "../../deployments/local/embedded-workspace-runtime"
import { startLocalServer, type LocalServer } from "../../app/start-local-server"
import { createLocalControlPlaneServices } from "../../app/local-services"
import { testDaemon } from "../../app/test-support/daemon"

/**
 * The publisher through its real entrypoints: the daemon's serving route
 * takes the credential and the publish address the heartbeat delivered, and
 * the control plane — a socket here — receives the projection's rows under
 * that credential's Host Tunnel Token.
 */

const WS_A = "11111111-1111-4111-8111-111111111111"
const WS_B = "22222222-2222-4222-8222-222222222222"

type Received = { authorization: string | undefined; body: { hostId: string; rows: HostSessionRow[]; removed: SessionRef[]; attention: SessionAttentionPublication[] } }

let dataDir: string
let previous: string | undefined
let server: LocalServer | undefined
let controlPlane: Server | undefined

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "claxedo-session-rows-e2e-"))
  previous = process.env.CLAXEDO_DATA_DIR
  process.env.CLAXEDO_DATA_DIR = dataDir
})

afterEach(async () => {
  stopHostServing()
  await server?.stop()
  server = undefined
  await new Promise<void>((resolve) => (controlPlane ? controlPlane.close(() => resolve()) : resolve()))
  controlPlane = undefined
  ClaxedoDB.close()
  if (previous === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previous
  rmSync(dataDir, { recursive: true, force: true })
})

function listen(target: Server) {
  return new Promise<string>((resolve) => {
    target.listen(0, "127.0.0.1", () => {
      const address = target.address()
      if (!address || typeof address === "string") throw new Error("no port")
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

async function freePort() {
  const probe = createServer()
  const origin = await listen(probe)
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return Number(new URL(origin).port)
}

async function until(ready: () => boolean, label: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function fakeControlPlane() {
  const received: Received[] = []
  const accepted = (body: Received["body"]) => {
    const named = new Set([...body.rows, ...body.removed].map((ref) => JSON.stringify([ref.workspaceId, ref.sessionId])))
    return { status: 200, body: { accepted: body.rows.length + body.removed.length
      + body.attention.filter((ref) => !named.has(JSON.stringify([ref.workspaceId, ref.sessionId]))).length, refused: [] } }
  }
  let answer: (body: Received["body"]) => { status: number; body: unknown } = accepted
  controlPlane = createServer((request, response) => {
    let raw = ""
    request.on("data", (chunk) => { raw += chunk })
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/api/claxedo/host/session-rows") {
        response.writeHead(404).end()
        return
      }
      received.push({ authorization: request.headers.authorization, body: JSON.parse(raw) as Received["body"] })
      const { status, body } = answer(received.at(-1)!.body)
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body))
    })
  })
  const origin = await listen(controlPlane)
  return {
    origin,
    received,
    sessionRowsUrl: `${origin}/api/claxedo/host/session-rows`,
    refuse: () => {
      answer = () => ({ status: 401, body: { error: { code: "invalid_host_tunnel_token" } } })
    },
    accept: () => {
      answer = accepted
    },
  }
}

async function boot() {
  const services = createLocalControlPlaneServices()
  const identity = testDaemon()
  const port = await freePort()
  server = startLocalServer({ port, daemon: identity.daemon, services, corsOrigin: (origin) => origin })
  await server.ready
  const cp = await fakeControlPlane()
  const serve = (credential: { token: string; workspaceIds: string[] } | null, endpoints?: Record<string, string>) =>
    identity.call(`http://127.0.0.1:${port}/api/claxedo/host-serving`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        credential: credential
          ? {
              hostTunnelToken: credential.token,
              tokenExpiresAt: Date.now() + 300_000,
              jti: `jti-${credential.token}`,
              hostId: "host_machine-1",
              enrollmentId: "enr_this_machine",
              generation: 0,
              ownerActorId: "actor_owner",
              ownerUserId: "usr_machine_owner",
              workspaceIds: credential.workspaceIds,
              relayUrl: cp.origin,
            }
          : null,
        ...(endpoints ? { endpoints } : {}),
      }),
    })
  return { services, cp, serve }
}

async function mountedWorkspace(workspaceId: string) {
  const directory = path.join(dataDir, workspaceId)
  mkdirSync(directory)
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: directory, stdio: "ignore" })
  const workspace = await ensureWorkspace({ workspaceId, directory, kind: "local" })
  if (!workspace) throw new Error("Canonical workspace registration failed")
  const runtime = await ensureEmbeddedWorkspaceRuntime(workspace, { config: "skip" })
  return { workspace, runtime }
}

async function seedSession(services: ReturnType<typeof createLocalControlPlaneServices>,
  mounted: Awaited<ReturnType<typeof mountedWorkspace>>, sessionId: string, title?: string, parentSessionId?: string) {
  const { workspace, runtime } = mounted
  const store = runtime.host.store()
  const harness = { id: "pi", access: "native" as const }
  store.bindSession({ sessionId, workspaceId: workspace.id, directory: workspace.directory, connectionId: connectionIdForHarness(harness),
    upstreamSessionId: `${sessionId}-up`, agentSessionId: `${sessionId}-up`, owner: { kind: "machine-owner" },
    ...(parentSessionId ? { parentSessionId } : {}) })
  store.updateSessionConfig(sessionId, { harness })
  if (title) store.updateSession(sessionId, { title })
  const session = store.getSession(sessionId)!
  await services.projectionStore.sync_session_meta(workspace, session)
  return session
}

describe("the machine publisher on the running daemon", () => {
  test("a serving credential publishes the served workspaces' rows to the delivered address under its token", async () => {
    const { services, cp, serve } = await boot()
    const a = await mountedWorkspace(WS_A)
    const b = await mountedWorkspace(WS_B)
    const original = await seedSession(services, a, "ses_a", "A")
    await seedSession(services, b, "ses_b", "B")
    await seedSession(services, a, "ses_child", undefined, "ses_a")

    expect((await serve({ token: "htt.1", workspaceIds: [WS_A] }, { sessionRowsUrl: cp.sessionRowsUrl })).status).toBe(200)
    await until(() => cp.received.length === 1, "the first publication")

    expect(cp.received[0]?.authorization).toBe("Bearer htt.1")
    expect(cp.received[0]?.body).toEqual({
      hostId: "host_machine-1",
      rows: [{
        workspaceId: WS_A,
        sessionId: "ses_a",
        title: "A",
        createdAt: original.time.created,
        updatedAt: original.time.updated,
        status: { kind: "idle", awaitingInput: false, at: expect.any(Number) },
        attention: original.attention,
        replayed: true,
      }],
      removed: [],
      attention: [{ workspaceId: WS_A, sessionId: "ses_a", generation: original.attention!.generation,
        through: original.attention!.sequence, events: [] }],
    })

    // A renewing ack with the same set publishes nothing more.
    expect((await serve({ token: "htt.2", workspaceIds: [WS_A] }, { sessionRowsUrl: cp.sessionRowsUrl })).status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(cp.received).toHaveLength(1)

    // A wider set republishes everything, with the renewed token.
    expect((await serve({ token: "htt.2", workspaceIds: [WS_A, WS_B] }, { sessionRowsUrl: cp.sessionRowsUrl })).status).toBe(200)
    await until(() => cp.received.length === 2, "the resync after the set changed")
    expect(cp.received[1]?.authorization).toBe("Bearer htt.2")
    expect(cp.received[1]?.body.rows.map((row) => row.sessionId)).toEqual(["ses_a", "ses_b"])

    // A canonical runtime mutation projects and publishes that row alone.
    b.runtime.host.store().updateSession("ses_b", { title: "renamed" })
    await services.projectionStore.sync_session_meta(b.workspace, b.runtime.host.store().getSession("ses_b"))
    await until(() => cp.received.length === 3, "the changed row")
    expect(cp.received[2]?.body.rows.map((row) => [row.sessionId, row.title])).toEqual([["ses_b", "renamed"]])
    expect(cp.received[2]?.body.removed).toEqual([])

    b.runtime.host.store().deleteSession("ses_b")
    await services.projectionStore.delete_session_meta("ses_b")
    await until(() => cp.received.length === 4, "the removed row")
    expect(cp.received[3]?.body).toEqual({ hostId: "host_machine-1", rows: [], removed: [{ workspaceId: WS_B, sessionId: "ses_b" }], attention: [] })
  })

  test("publishes nothing without the address, and a refused token waits for the next credential", async () => {
    const { services, cp, serve } = await boot()
    const a = await mountedWorkspace(WS_A)
    await seedSession(services, a, "ses_a")

    expect((await serve({ token: "htt.1", workspaceIds: [WS_A] })).status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(cp.received, "no address, nothing sent").toHaveLength(0)

    cp.refuse()
    expect((await serve({ token: "htt.1", workspaceIds: [WS_A] }, { sessionRowsUrl: cp.sessionRowsUrl })).status).toBe(200)
    await until(() => cp.received.length === 1, "the refused publication")
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(cp.received, "the refused token is not retried").toHaveLength(1)

    cp.accept()
    expect((await serve({ token: "htt.2", workspaceIds: [WS_A] }, { sessionRowsUrl: cp.sessionRowsUrl })).status).toBe(200)
    await until(() => cp.received.length === 2, "the publication under the renewed token")
    expect(cp.received[1]?.authorization).toBe("Bearer htt.2")

    expect((await serve(null)).status).toBe(200)
    a.runtime.host.store().updateSession("ses_a", { title: "renamed" })
    await services.projectionStore.sync_session_meta(a.workspace, a.runtime.host.store().getSession("ses_a"))
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(cp.received, "nothing published once serving stopped").toHaveLength(2)
  })

  test("canonical live Working immediately after admission shares the first batch with quiet startup work", async () => {
    const { services, cp, serve } = await boot()
    const a = await mountedWorkspace(WS_A)
    await seedSession(services, a, "held", "Held")
    const store = a.runtime.host.store()
    store.startTurn({ sessionId: "held", agentSessionId: "held-up", userMessageId: "held-prompt", assistantMessageId: "held-answer", agent: "build", parts: [] })
    const initial = store.getSession("held")!
    await services.projectionStore.sync_session_meta(a.workspace, initial)
    let projected: Promise<void> | undefined
    const unsubscribe = onHostServingCredential((credential) => {
      if (credential?.token !== "htt.initial" || projected) return
      // The composition captured the mounted baseline in its admission listener first.
      store.updateSession("held", { title: "Renamed startup work" })
      store.bindSession({ sessionId: "fresh", workspaceId: WS_A, directory: a.workspace.directory,
        connectionId: connectionIdForHarness({ id: "pi", access: "native" }), upstreamSessionId: "fresh-up", agentSessionId: "fresh-up", owner: { kind: "machine-owner" } })
      store.updateSessionConfig("fresh", { harness: { id: "pi", access: "native" } })
      store.startTurn({ sessionId: "fresh", agentSessionId: "fresh-up", userMessageId: "fresh-prompt", assistantMessageId: "fresh-answer", agent: "build", parts: [] })
      projected = Promise.all([
        services.projectionStore.sync_session_meta(a.workspace, store.getSession("held")),
        services.projectionStore.sync_session_meta(a.workspace, store.getSession("fresh")),
      ]).then(() => undefined)
    })
    try {
      expect((await serve({ token: "htt.initial", workspaceIds: [WS_A] }, { sessionRowsUrl: cp.sessionRowsUrl })).status).toBe(200)
      expect(projected).toBeDefined()
      await projected
      await until(() => cp.received.length === 1, "the initial Working batch")
      const first = cp.received[0]
      expect(first.authorization).toBe("Bearer htt.initial")
      expect(first.body.rows.map((row) => row.sessionId).sort((a, b) => a.localeCompare(b))).toEqual(["fresh", "held"])
      const held = first.body.rows.find((row) => row.sessionId === "held")!
      const fresh = first.body.rows.find((row) => row.sessionId === "fresh")!
      expect(held).toMatchObject({ replayed: true, title: "Renamed startup work", attention: { working: true } })
      expect(fresh).toMatchObject({ replayed: false, attention: store.getSession("fresh")!.attention })
      expect(fresh.attention!.working).toBe(true)
      expect(first.body.attention.map((batch) => [batch.sessionId, batch.through]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))).toEqual(
        first.body.rows.map((row) => [row.sessionId, row.attention!.sequence]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
    } finally { unsubscribe() }
  })
})
