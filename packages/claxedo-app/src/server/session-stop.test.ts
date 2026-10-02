/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { placementId, projectId, sessionId } from "./ids"
import { readStopsBackgroundTasks, stopBackgroundTask } from "./session-stop"
import { bootstrap } from "./test-session-server"
import { createTransport } from "./transport"
import { createWorkspaces } from "./workspaces"

const running: Array<{ stop: (force: boolean) => unknown }> = []

afterEach(() => {
  for (const server of running.splice(0)) server.stop(true)
})

const ref = { projectId: projectId("proj_1"), placementId: placementId("ws_cloud"), sessionId: sessionId("ses_1") }

async function fixture(capabilities: unknown) {
  const stops: unknown[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/api/claxedo/bootstrap") return Response.json(bootstrap(() => true, false))
      if (url.pathname === "/workspaces/ws_cloud/session/ses_1/capabilities") return Response.json(capabilities)
      if (url.pathname === "/workspaces/ws_cloud/session/ses_1/background-task/stop" && request.method === "POST") {
        const body = (await request.json()) as { toolCallId: string }
        stops.push(body)
        if (body.toolCallId === "toolu_agent") return Response.json({ ok: true })
        if (body.toolCallId === "toolu_gone") return Response.json({ ok: false, status: "not_found", message: "No running background task for toolu_gone" }, { status: 404 })
        return Response.json({ ok: false, error: { code: "unsupported_operation", message: "codex does not support background_task_stop" } }, { status: 409 })
      }
      return Response.json({ error: { code: "unexpected", message: url.pathname } }, { status: 500 })
    },
  })
  running.push(server)
  const transport = createTransport({ serverUrl: `http://127.0.0.1:${server.port}` })
  const workspaces = createWorkspaces(transport, new QueryClient())
  return { transport, route: await workspaces.route(ref), stops, dispose: () => workspaces.dispose() }
}

test("stopping a background task names it by its call and answers what the runtime answered, not_found included", async () => {
  const f = await fixture({})
  expect(await stopBackgroundTask(f.transport, f.route, ref, "toolu_agent")).toEqual({ ok: true })
  expect(await stopBackgroundTask(f.transport, f.route, ref, "toolu_gone")).toEqual({ ok: false, status: "not_found", message: "No running background task for toolu_gone" })
  expect(await stopBackgroundTask(f.transport, f.route, ref, "toolu_other").then(() => undefined, (error: unknown) => error)).toMatchObject({ class: "conflict", code: "unsupported_operation" })
  expect(f.stops).toEqual([{ toolCallId: "toolu_agent" }, { toolCallId: "toolu_gone" }, { toolCallId: "toolu_other" }])
  f.dispose()
})

test("a session's harness stops background tasks only when its capabilities say so", async () => {
  const able = await fixture({ harness: "claude", backgroundTasks: true })
  expect(await readStopsBackgroundTasks(able.transport, able.route, ref)).toBe(true)
  able.dispose()
  const unable = await fixture({ harness: "codex", backgroundTasks: false })
  expect(await readStopsBackgroundTasks(unable.transport, unable.route, ref)).toBe(false)
  unable.dispose()
})
