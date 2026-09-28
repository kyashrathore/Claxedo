/// <reference types="bun" />
import { expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { placementId, projectId, sessionId } from "./ids"
import { createPlacementStreams } from "./placement-streams"
import type { Transport } from "./transport"
import type { Workspaces } from "./workspaces"

async function settle() {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve()
}

function openBody(): Response {
  return new Response(new ReadableStream<Uint8Array>({ start: () => undefined }), { headers: { "content-type": "text/event-stream" } })
}

const placement = placementId("ws_shared")
const record = {
  placement: { id: placement, projectId: projectId("prj"), kind: "worktree", label: "Shared", reachable: true },
  route: { directory: "workspace:ws_shared", workspaceId: "ws_shared", remote: true },
}
const workspaces = { catalog: () => ({ projects: [], placements: [record] }) } as unknown as Workspaces

function ref(id: string) {
  return { projectId: projectId("prj"), placementId: placement, sessionId: sessionId(id) }
}

test("a share grantee refused the workspace stream reads each attached session's own stream, and a refused session stream stays closed", async () => {
  const paths: string[] = []
  const transport = {
    serverUrl: "http://127.0.0.1:1",
    runtime: async (_route: unknown, path: string) => {
      paths.push(path)
      if (path === "/api/wr/events") return Response.json({ error: { code: "workspace_event_stream_denied" } }, { status: 403 })
      if (path === "/api/wr/events?sessionID=ses_revoked") return Response.json({ error: { code: "session_event_stream_denied" } }, { status: 403 })
      return openBody()
    },
  } as unknown as Transport
  const streams = createPlacementStreams({ transport, workspaces, queryClient: new QueryClient(), onFrame: () => undefined, onGap: () => undefined })

  const detachShared = streams.attach(ref("ses_shared"))
  await settle()
  const detachRevoked = streams.attach(ref("ses_revoked"))
  await settle()
  await Bun.sleep(1_200)
  await settle()

  expect(paths).toEqual(["/api/wr/events", "/api/wr/events?sessionID=ses_shared", "/api/wr/events?sessionID=ses_revoked"])
  detachShared()
  detachRevoked()
  streams.close()
})
