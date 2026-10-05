/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { createBrowserHostedAccount } from "./account"
import { ServerError } from "./errors"
import { placementId, projectId, sessionId } from "./ids"
import { createSessionProjection, type SessionProjection } from "./session-projection"
import { RESERVATION_HEADER } from "./session-reservation"
import { createSessionsApi } from "./sessions"
import type { ProductEvent } from "@claxedo/account-contract/product-events"
import type { ProductTelemetry } from "./telemetry"
import { createStatusOwner, type StatusOwner } from "./status"
import { bootstrap } from "./test-session-server"
import { createTransport, type Transport } from "./transport"
import { createWorkspaces, type Workspaces } from "./workspaces"
import { createWorkspaceWakes, type WorkspaceWakes } from "./workspace-wakes"

const running: Array<{ stop: (force: boolean) => unknown }> = []
const recorded: ProductEvent[] = []
const telemetry: ProductTelemetry = { record: (event) => void recorded.push(event) }

afterEach(() => {
  for (const server of running.splice(0)) server.stop(true)
  recorded.length = 0
})

test.each([["cloud", false], ["remote machine", true]] as const)("sessions: a %s create is reserved through the account, and a refusal for another workspace's id rejects with that typed conflict", async (_kind, machine) => {
  const creates: Array<{ id?: unknown; operation: string | null }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/api/claxedo/bootstrap") return Response.json(bootstrap(() => true, machine))
      if (url.pathname === "/api/control/session-registrations/reserve") return Response.json({ ...(await request.json()), state: "reserved" })
      if (url.pathname === "/workspaces/ws_cloud/session" && request.method === "POST") {
        const body = (await request.json()) as { id?: unknown }
        creates.push({ id: body.id, operation: request.headers.get(RESERVATION_HEADER) })
        return Response.json({ error: { code: "session_create_conflict", message: `Session ${String(body.id)} belongs to another workspace` } }, { status: 409 })
      }
      return Response.json({ error: { code: "unexpected", message: url.pathname } }, { status: 500 })
    },
  })
  running.push(server)
  const transport = createTransport({ serverUrl: `http://127.0.0.1:${server.port}`, cookies: true })
  const account = createBrowserHostedAccount(transport)
  const workspaces = createWorkspaces(transport, new QueryClient())
  const sessions = createSessionsApi(transport, workspaces, createStatusOwner(transport), createWorkspaceWakes(transport, workspaces), createSessionProjection(workspaces, account), telemetry, account)

  const refusal = await sessions.create({ placementId: placementId("ws_cloud") }).then(
    () => undefined,
    (error: unknown) => error,
  )

  expect(creates).toHaveLength(1)
  expect(creates[0]?.id).toEqual(expect.stringMatching(/^ses_/))
  expect(creates[0]?.operation).toEqual(expect.stringMatching(/^session_registration/))
  expect(refusal).toMatchObject({
    class: "conflict",
    code: "session_create_conflict",
    status: 409,
    retryable: false,
    message: `Session ${String(creates[0]?.id)} belongs to another workspace`,
  })
  workspaces.dispose()
})

type HostedRequest = { method: string; path: string; authorization: string | null; id?: unknown; operation: string | null }

function sessionHostServer(minted: unknown[], hosted: HostedRequest[], reservations: unknown[]) {
  let origin = ""
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request): Promise<Response> => {
      const url = new URL(request.url)
      if (url.pathname === "/api/claxedo/bootstrap") return Response.json(bootstrap(() => true, false))
      if (url.pathname === "/api/control/session-registrations/reserve") {
        const reserved = (await request.json()) as { sessionId: string; harness?: { id: string } }
        reservations.push(reserved)
        return Response.json({ ...reserved, state: "reserved", ...(reserved.harness?.id === "pi" ? { sessionHostRoot: reserved.sessionId } : {}) })
      }
      if (url.pathname === "/api/workspace/ws_cloud/connection" && request.method === "POST") {
        const body = (await request.json()) as { session: { sessionId: string } }
        minted.push(body)
        return Response.json({
          backing: "durable-object", workspaceId: "ws_cloud", hostId: `session-do:${body.session.sessionId}`, sessionId: body.session.sessionId,
          relayUrl: `${origin}/relay`, runtimeAccessToken: "session-host-rat", tokenExpiresAt: Date.now() + 3_600_000, role: "editor",
        })
      }
      if (url.pathname.startsWith("/relay/workspaces/ws_cloud/session")) {
        const body = request.method === "POST" ? (await request.json()) as { id?: unknown } : {}
        hosted.push({ method: request.method, path: url.pathname, authorization: request.headers.get("authorization"), ...(body.id === undefined ? {} : { id: body.id }), operation: request.headers.get(RESERVATION_HEADER) })
        const id = url.pathname.split("/").pop()
        return Response.json({ id, title: "Pi", time: { created: 1, updated: 1 } })
      }
      if (url.pathname.startsWith("/api/control/")) return Response.json({ ok: true })
      return Response.json({ error: { code: "unexpected", message: url.pathname } }, { status: 500 })
    },
  })
  origin = `http://127.0.0.1:${server.port}`
  running.push(server)
  return origin
}

test("sessions: a create the control plane reserves in its own host connects there first, is created at its path there, and is then read there", async () => {
  const minted: unknown[] = []
  const hosted: HostedRequest[] = []
  const reservations: unknown[] = []
  const origin = sessionHostServer(minted, hosted, reservations)
  const transport = createTransport({ serverUrl: origin, cookies: true })
  const account = createBrowserHostedAccount(transport)
  const workspaces = createWorkspaces(transport, new QueryClient())
  const sessions = createSessionsApi(transport, workspaces, createStatusOwner(transport), createWorkspaceWakes(transport, workspaces), createSessionProjection(workspaces, account), telemetry, account)

  const row = await sessions.create({ placementId: placementId("ws_cloud"), harness: "pi" })
  const id = String(row.ref.sessionId)
  expect(reservations).toEqual([expect.objectContaining({ sessionId: id, harness: { id: "pi", access: "native" } })])
  expect(minted).toEqual([{ session: { sessionId: id } }])
  expect(hosted).toEqual([{ method: "POST", path: `/relay/workspaces/ws_cloud/session/${id}`, authorization: "Bearer session-host-rat", operation: expect.stringMatching(/^session_registration/) }])
  expect((await workspaces.route(row.ref)).sessionHost).toEqual({ sessionId: id })
  await transport.runtime(await workspaces.route(row.ref), `/session/${id}`)
  expect(hosted.at(-1)).toMatchObject({ method: "GET", path: `/relay/workspaces/ws_cloud/session/${id}`, authorization: "Bearer session-host-rat" })
  expect(recorded).toEqual([{ event: "session_started", properties: { harness: "pi", where: "cloud" } }])
  workspaces.dispose()
})

test("sessions: a create the control plane places in the workspace's runtime mints no session connection", async () => {
  const minted: unknown[] = []
  const hosted: HostedRequest[] = []
  const reservations: unknown[] = []
  const origin = sessionHostServer(minted, hosted, reservations)
  const transport = createTransport({ serverUrl: origin, cookies: true })
  const account = createBrowserHostedAccount(transport)
  const workspaces = createWorkspaces(transport, new QueryClient())
  const sessions = createSessionsApi(transport, workspaces, createStatusOwner(transport), createWorkspaceWakes(transport, workspaces), createSessionProjection(workspaces, account), telemetry, account)
  await expect(sessions.create({ placementId: placementId("ws_cloud"), harness: "codex" })).rejects.toMatchObject({ message: "/workspaces/ws_cloud/session" })
  expect(reservations).toEqual([expect.objectContaining({ harness: { id: "codex", access: "native" } })])
  expect(minted).toEqual([])
  expect(hosted).toEqual([])
  expect(recorded).toEqual([])
  workspaces.dispose()
})

function sendFixture(answers: Array<unknown>, stopsOnRefresh: boolean) {
  const sent: string[] = []
  const bodies: unknown[] = []
  let settled = 0
  let stopped = false
  const woke: string[] = []
  const transport = {
    runtimeJson: async (_route: unknown, path: string, init?: RequestInit) => {
      sent.push(path)
      bodies.push(init?.body)
      const answer = answers.shift()
      if (answer instanceof Error) throw answer
      return answer
    },
  } as unknown as Transport
  const workspaces = {
    route: async () => ({ directory: "workspace:ws_cloud", workspaceId: "ws_cloud", remote: true }),
    refresh: async () => { stopped = stopsOnRefresh },
  } as unknown as Workspaces
  const wakes = {
    wakeIfStopped: async (id: string) => {
      if (!stopped) return false
      woke.push(id)
      stopped = false
      return true
    },
    settle: async () => {
      settled += 1
      return false
    },
  } as unknown as WorkspaceWakes
  const sessions = createSessionsApi(transport, workspaces, {} as StatusOwner, wakes, {} as SessionProjection, telemetry)
  const send = () => sessions.prompt({ projectId: projectId("proj_1"), placementId: placementId("ws_cloud"), sessionId: sessionId("ses_1") },
    { clientRequestId: "req_1", messageId: "msg_1", text: "hello", attachments: [] })
  return { sent, bodies, woke, send, settled: () => settled }
}

test("sessions: a send a sandbox refuses because it stopped since the catalog read wakes it and is sent once more", async () => {
  const stopped = new ServerError({ class: "conflict", code: "workspace_stopped", message: "The cloud workspace is stopped" })
  const fixture = sendFixture([stopped, { delivery: "queue" }], true)
  expect(await fixture.send()).toBe("queue")
  expect(fixture.sent).toHaveLength(2)
  expect(fixture.woke).toEqual(["ws_cloud"])
})

test("sessions: a refused send is not resent when the sandbox did not stop, or when it was refused for another reason", async () => {
  const stopped = new ServerError({ class: "conflict", code: "workspace_stopped", message: "The cloud workspace is stopped" })
  const stillLive = sendFixture([stopped], false)
  await expect(stillLive.send()).rejects.toBe(stopped)
  expect(stillLive.sent).toHaveLength(1)
  const denied = new ServerError({ class: "forbidden", code: "session_access_denied", message: "Not yours" })
  const refused = sendFixture([denied], true)
  await expect(refused.send()).rejects.toBe(denied)
  expect(refused.woke).toEqual([])
})

test("sessions: a send the runtime refuses while a checkpoint holds it frozen waits for the checkpoint to settle and is sent again with the same message", async () => {
  const frozen = new ServerError({ class: "conflict", status: 423, code: "workspace_checkpoint_frozen", message: "Workspace writes are paused for a checkpoint" })
  const fixture = sendFixture([frozen, frozen, { delivery: "queue" }], false)
  expect(await fixture.send()).toBe("queue")
  expect(fixture.settled()).toBe(2)
  expect(new Set(fixture.bodies).size).toBe(1)
  expect(fixture.bodies[0]).toContain('"msg_1"')
})
