import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { closeAuthorityDatabases } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
import { stopHostServing } from "@claxedo/host-serving/serving"
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

type Received = { authorization: string | undefined; body: { hostId: string; rows: Array<Record<string, unknown>>; removed: unknown[] } }

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
  closeAuthorityDatabases()
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
  let answer: () => { status: number; body: unknown } = () => ({ status: 200, body: { accepted: 0, refused: [] } })
  controlPlane = createServer((request, response) => {
    let raw = ""
    request.on("data", (chunk) => { raw += chunk })
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/api/claxedo/host/session-rows") {
        response.writeHead(404).end()
        return
      }
      received.push({ authorization: request.headers.authorization, body: JSON.parse(raw) as Received["body"] })
      const { status, body } = answer()
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
      answer = () => ({ status: 200, body: { accepted: 1, refused: [] } })
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
              workspaceIds: credential.workspaceIds,
              relayUrl: cp.origin,
            }
          : null,
        ...(endpoints ? { endpoints } : {}),
      }),
    })
  return { services, cp, serve }
}

describe("the machine publisher on the running daemon", () => {
  test("a serving credential publishes the served workspaces' rows to the delivered address under its token", async () => {
    const { services, cp, serve } = await boot()
    await services.projectionStore.put_session_meta("ses_a", { workspaceID: WS_A, directory: "/work/a", title: "A", createdAt: 1_000, updatedAt: 2_000 })
    await services.projectionStore.put_session_meta("ses_b", { workspaceID: WS_B, directory: "/work/b", title: "B", createdAt: 1_000, updatedAt: 2_000 })
    await services.projectionStore.put_session_meta("ses_child", { workspaceID: WS_A, directory: "/work/a", parentID: "ses_a", createdAt: 1_000, updatedAt: 2_000 })

    expect((await serve({ token: "htt.1", workspaceIds: [WS_A] }, { sessionRowsUrl: cp.sessionRowsUrl })).status).toBe(200)
    await until(() => cp.received.length === 1, "the first publication")

    expect(cp.received[0]?.authorization).toBe("Bearer htt.1")
    expect(cp.received[0]?.body).toEqual({
      hostId: "host_machine-1",
      rows: [{
        workspaceId: WS_A,
        sessionId: "ses_a",
        title: "A",
        createdAt: 1_000,
        updatedAt: 2_000,
        status: { kind: "idle", awaitingInput: false, at: expect.any(Number) },
      }],
      removed: [],
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

    // A write through the projection's own writer publishes that row alone.
    await services.projectionStore.put_session_meta("ses_b", { title: "renamed" })
    await until(() => cp.received.length === 3, "the changed row")
    expect(cp.received[2]?.body.rows.map((row) => [row.sessionId, row.title])).toEqual([["ses_b", "renamed"]])
    expect(cp.received[2]?.body.removed).toEqual([])

    await services.projectionStore.delete_session_meta("ses_b")
    await until(() => cp.received.length === 4, "the removed row")
    expect(cp.received[3]?.body).toEqual({ hostId: "host_machine-1", rows: [], removed: [{ workspaceId: WS_B, sessionId: "ses_b" }] })
  })

  test("publishes nothing without the address, and a refused token waits for the next credential", async () => {
    const { services, cp, serve } = await boot()
    await services.projectionStore.put_session_meta("ses_a", { workspaceID: WS_A, directory: "/work/a", createdAt: 1_000, updatedAt: 2_000 })

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
    await services.projectionStore.put_session_meta("ses_a", { title: "renamed" })
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(cp.received, "nothing published once serving stopped").toHaveLength(2)
  })
})
