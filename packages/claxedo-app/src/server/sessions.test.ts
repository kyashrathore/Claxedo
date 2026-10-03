/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { createBrowserHostedAccount } from "./account"
import { ServerError } from "./errors"
import { placementId, projectId, sessionId } from "./ids"
import { createSessionProjection, type SessionProjection } from "./session-projection"
import { RESERVATION_HEADER } from "./session-reservation"
import { createSessionsApi } from "./sessions"
import { createStatusOwner, type StatusOwner } from "./status"
import { bootstrap } from "./test-session-server"
import { createTransport, type Transport } from "./transport"
import { createWorkspaces, type Workspaces } from "./workspaces"
import { createWorkspaceWakes, type WorkspaceWakes } from "./workspace-wakes"

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

function sendFixture(answers: Array<unknown>, stopsOnRefresh: boolean) {
  const sent: string[] = []
  let stopped = false
  const woke: string[] = []
  const transport = {
    runtimeJson: async (_route: unknown, path: string) => {
      sent.push(path)
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
  } as unknown as WorkspaceWakes
  const sessions = createSessionsApi(transport, workspaces, {} as StatusOwner, wakes, {} as SessionProjection)
  const send = () => sessions.prompt({ projectId: projectId("proj_1"), placementId: placementId("ws_cloud"), sessionId: sessionId("ses_1") },
    { clientRequestId: "req_1", messageId: "msg_1", text: "hello", attachments: [] })
  return { sent, woke, send }
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
  const denied = new ServerError({ class: "auth", code: "session_access_denied", message: "Not yours" })
  const refused = sendFixture([denied], true)
  await expect(refused.send()).rejects.toBe(denied)
  expect(refused.woke).toEqual([])
})
