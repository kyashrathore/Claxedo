/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
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

test("sessions: a create the runtime refuses because the reserved id belongs to another workspace rejects with that typed conflict", async () => {
  const creates: Array<{ id?: unknown; operation: string | null }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/api/claxedo/bootstrap") return Response.json(bootstrap(() => true, false))
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
  const transport = createTransport({ serverUrl: `http://127.0.0.1:${server.port}`, auth: { kind: "none" } })
  const workspaces = createWorkspaces(transport, new QueryClient())
  const sessions = createSessionsApi(transport, workspaces, createStatusOwner(transport), createWorkspaceWakes(transport, workspaces), createSessionProjection(transport, workspaces))

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
