/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import type { ProductEvent } from "@claxedo/account-contract/product-events"
import { createBrowserHostedAccount } from "./account"
import { placementId } from "./ids"
import { createSessionProjection } from "./session-projection"
import { RESERVATION_HEADER } from "./session-reservation"
import { createSessionsApi } from "./sessions"
import { createStatusOwner } from "./status"
import type { ProductTelemetry } from "./telemetry"
import { bootstrap } from "./test-session-server"
import { createTransport } from "./transport"
import type { SessionReservation } from "./types"
import { PROMPT_ROUTE } from "./wire/prompt"
import { createWorkspaces } from "./workspaces"
import { createWorkspaceWakes, type WorkspaceWakes } from "./workspace-wakes"

const running: Array<{ stop: (force: boolean) => unknown }> = []
const recorded: ProductEvent[] = []
const telemetry: ProductTelemetry = { record: (event) => void recorded.push(event) }

afterEach(() => {
  for (const server of running.splice(0)) server.stop(true)
  recorded.length = 0
})

type HostedRequest = { method: string; path: string; authorization: string | null; id?: unknown; operation: string | null }

function sessionHostServer(minted: unknown[], hosted: HostedRequest[], reservations: unknown[], reachable = true) {
  let origin = ""
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request): Promise<Response> => {
      const url = new URL(request.url)
      if (url.pathname === "/api/claxedo/bootstrap") return Response.json(bootstrap(() => reachable, false))
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
        if (url.pathname.endsWith(PROMPT_ROUTE)) return Response.json({ delivery: "queue" })
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
  const sessions = createSessionsApi(transport, workspaces, createStatusOwner(transport), createWorkspaceWakes(transport, workspaces, () => () => undefined), createSessionProjection(workspaces, account), telemetry, account)

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

test("sessions: a draft reserved under Codex that switches to Pi before it lands reserves again as Pi and is created in the control plane's host, not in the workspace's runtime", async () => {
  const minted: unknown[] = []
  const hosted: HostedRequest[] = []
  const reservations: Array<{ sessionId: string; harness?: { id: string } }> = []
  const origin = sessionHostServer(minted, hosted, reservations)
  const transport = createTransport({ serverUrl: origin, cookies: true })
  const account = createBrowserHostedAccount(transport)
  const workspaces = createWorkspaces(transport, new QueryClient())
  const sessions = createSessionsApi(transport, workspaces, createStatusOwner(transport), createWorkspaceWakes(transport, workspaces, () => () => undefined), createSessionProjection(workspaces, account), telemetry, account)
  let held: SessionReservation | undefined
  const reservation = { held: () => held, hold: (next: SessionReservation) => { held = next } }

  await expect(sessions.create({ placementId: placementId("ws_cloud"), harness: "codex", reservation })).rejects.toMatchObject({ message: "/workspaces/ws_cloud/session" })
  expect(held).toMatchObject({ sessionId: reservations[0]?.sessionId, harness: { id: "codex", access: "native" } })
  const row = await sessions.create({ placementId: placementId("ws_cloud"), harness: "pi", reservation })

  const id = String(row.ref.sessionId)
  expect(reservations.map((reserved) => reserved.harness?.id)).toEqual(["codex", "pi"])
  expect(id).toBe(reservations[1].sessionId)
  expect(id).not.toBe(reservations[0].sessionId)
  expect(held).toMatchObject({ sessionId: id, sessionHostRoot: id, harness: { id: "pi", access: "native" } })
  expect(minted).toEqual([{ session: { sessionId: id } }])
  expect(hosted).toEqual([expect.objectContaining({ method: "POST", path: `/relay/workspaces/ws_cloud/session/${id}` })])
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
  const sessions = createSessionsApi(transport, workspaces, createStatusOwner(transport), createWorkspaceWakes(transport, workspaces, () => () => undefined), createSessionProjection(workspaces, account), telemetry, account)
  await expect(sessions.create({ placementId: placementId("ws_cloud"), harness: "codex" })).rejects.toMatchObject({ message: "/workspaces/ws_cloud/session" })
  expect(reservations).toEqual([expect.objectContaining({ harness: { id: "codex", access: "native" } })])
  expect(minted).toEqual([])
  expect(hosted).toEqual([])
  expect(recorded).toEqual([])
  workspaces.dispose()
})

function recordedWakes(woke: string[]) {
  return { wakeIfStopped: async (id: string) => { woke.push(id); return true } } as unknown as WorkspaceWakes
}

test("sessions: a Pi create on a sleeping cloud workspace wakes nothing: it is reserved, connected and created in its own host, and its sends go there", async () => {
  const minted: unknown[] = []
  const hosted: HostedRequest[] = []
  const reservations: unknown[] = []
  const woke: string[] = []
  const origin = sessionHostServer(minted, hosted, reservations, false)
  const transport = createTransport({ serverUrl: origin, cookies: true })
  const account = createBrowserHostedAccount(transport)
  const workspaces = createWorkspaces(transport, new QueryClient())
  const sessions = createSessionsApi(transport, workspaces, createStatusOwner(transport), recordedWakes(woke), createSessionProjection(workspaces, account), telemetry, account)

  const row = await sessions.create({ placementId: placementId("ws_cloud"), harness: "pi" })
  const id = String(row.ref.sessionId)
  expect(hosted).toEqual([expect.objectContaining({ method: "POST", path: `/relay/workspaces/ws_cloud/session/${id}` })])
  expect(await sessions.prompt(row.ref, { clientRequestId: "req_1", messageId: "msg_1", text: "hello", attachments: [] })).toBe("queue")
  expect(hosted.at(-1)).toMatchObject({ method: "POST", path: `/relay/workspaces/ws_cloud/session/${id}${PROMPT_ROUTE}`, authorization: "Bearer session-host-rat" })
  expect(woke).toEqual([])
  workspaces.dispose()
})

test("sessions: a create the control plane places in a sleeping workspace's runtime wakes it first", async () => {
  const minted: unknown[] = []
  const hosted: HostedRequest[] = []
  const reservations: unknown[] = []
  const woke: string[] = []
  const origin = sessionHostServer(minted, hosted, reservations, false)
  const transport = createTransport({ serverUrl: origin, cookies: true })
  const account = createBrowserHostedAccount(transport)
  const workspaces = createWorkspaces(transport, new QueryClient())
  const sessions = createSessionsApi(transport, workspaces, createStatusOwner(transport), recordedWakes(woke), createSessionProjection(workspaces, account), telemetry, account)
  await expect(sessions.create({ placementId: placementId("ws_cloud"), harness: "codex" })).rejects.toBeDefined()
  expect(reservations).toEqual([expect.objectContaining({ harness: { id: "codex", access: "native" } })])
  expect(woke).toEqual(["ws_cloud"])
  expect(minted).toEqual([])
  workspaces.dispose()
})
