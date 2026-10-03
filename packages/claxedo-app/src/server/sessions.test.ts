/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { createBrowserHostedAccount } from "./account"
import { placementId } from "./ids"
import { createSessionProjection } from "./session-projection"
import { RESERVATION_HEADER } from "./session-reservation"
import { createSessionsApi } from "./sessions"
import { createStatusOwner } from "./status"
import { bootstrap } from "./test-session-server"
import { createTransport } from "./transport"
import { createWorkspaces } from "./workspaces"
import { createWorkspaceWakes } from "./workspace-wakes"

const running: Array<{ stop: (force: boolean) => unknown }> = []

afterEach(() => {
  for (const server of running.splice(0)) server.stop(true)
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
  const sessions = createSessionsApi(transport, workspaces, createStatusOwner(transport), createWorkspaceWakes(transport, workspaces), createSessionProjection(workspaces, account), account)

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
  const sessions = createSessionsApi(transport, workspaces, createStatusOwner(transport), createWorkspaceWakes(transport, workspaces), createSessionProjection(workspaces, account), account)

  const row = await sessions.create({ placementId: placementId("ws_cloud"), harness: "pi" })
  const id = String(row.ref.sessionId)
  expect(reservations).toEqual([expect.objectContaining({ sessionId: id, harness: { id: "pi", access: "native" } })])
  expect(minted).toEqual([{ session: { sessionId: id } }])
  expect(hosted).toEqual([{ method: "POST", path: `/relay/workspaces/ws_cloud/session/${id}`, authorization: "Bearer session-host-rat", operation: expect.stringMatching(/^session_registration/) }])
  expect((await workspaces.route(row.ref)).sessionHost).toEqual({ sessionId: id })
  await transport.runtime(await workspaces.route(row.ref), `/session/${id}`)
  expect(hosted.at(-1)).toMatchObject({ method: "GET", path: `/relay/workspaces/ws_cloud/session/${id}`, authorization: "Bearer session-host-rat" })
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
  const sessions = createSessionsApi(transport, workspaces, createStatusOwner(transport), createWorkspaceWakes(transport, workspaces), createSessionProjection(workspaces, account), account)
  await expect(sessions.create({ placementId: placementId("ws_cloud"), harness: "codex" })).rejects.toMatchObject({ message: "/workspaces/ws_cloud/session" })
  expect(reservations).toEqual([expect.objectContaining({ harness: { id: "codex", access: "native" } })])
  expect(minted).toEqual([])
  expect(hosted).toEqual([])
  workspaces.dispose()
})
