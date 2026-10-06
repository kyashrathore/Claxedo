/// <reference types="bun" />
import { expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { createRoot } from "solid-js"
import { placementId, projectId, sessionId } from "./ids"
import { createPlacementStreams } from "./placement-streams"
import { openBody, record, ref, settle, streamTransport, workspaces } from "./test-support/placement-streams"
import { queryKeys } from "./query-keys"
import type { RuntimeRoute, SessionHostListener } from "./transport"
import { createWorkspaces, type Workspaces } from "./workspaces"

test("a cloud session's stream opens only once its host is known, on the host that serves it", async () => {
  const routes: unknown[] = []
  const hosted = { ...record.route, sessionHost: { sessionId: "ses_pi" } }
  let known: typeof hosted | undefined
  const answered = Promise.withResolvers<void>()
  const workspaces = {
    streamRoute: () => known,
    onSessionHostLearned: () => () => undefined,
    home: async () => {
      await answered.promise
      known = hosted
      return { route: hosted, central: false, live: true }
    },
  } as unknown as Workspaces
  const transport = streamTransport({ serverUrl: "http://127.0.0.1:1", runtime: async (route: unknown) => (routes.push(route), openBody()) })
  const streams = createPlacementStreams({ transport, workspaces, queryClient: new QueryClient(), onFrame: () => undefined, onGap: () => undefined })
  const detach = streams.attach(ref("ses_pi"))
  await settle()
  expect(routes, "no stream before the host is known").toEqual([])
  answered.resolve()
  await settle()
  expect(routes).toEqual([hosted])
  detach()
  streams.close()
})

function hostLearningTransport(seen: string[]) {
  const opened: { route: RuntimeRoute; signal: AbortSignal }[] = []
  let announce: SessionHostListener | undefined
  const transport = streamTransport({
    serverUrl: "https://claxedo.test",
    loopback: false,
    json: async () => ({
      deployment: { serverKind: "daemon", issuesSessions: true },
      host: { name: "Ada's MacBook" },
      project: [{ id: "prj_pi", worktree: "ws_cloud", workspaces: { ws_cloud: { id: "ws_cloud", backing: "cloud-vm", workspace_name: "pi", reachable: true, directory: "workspace:ws_cloud" } } }],
    }),
    findSessionHost: async () => undefined,
    onSessionHost: (listener: SessionHostListener) => {
      announce = listener
      return () => undefined
    },
    runtime: async (route: RuntimeRoute, _path: string, init: { signal: AbortSignal }) => {
      opened.push({ route, signal: init.signal })
      seen.push(`opened ${route.sessionHost?.sessionId ?? "workspace"}`)
      return openBody()
    },
  })
  return { transport, opened, announce: (sessionHost: string) => announce?.("ws_cloud", "ses_pi", sessionHost) }
}

test("a session whose stream opened against its workspace moves to its own host once the host becomes known, and the reader re-reads what the move missed", async () => {
  await createRoot(async (dispose) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const seen: string[] = []
    const { transport, opened, announce } = hostLearningTransport(seen)
    const workspaces = createWorkspaces(transport, queryClient)
    const streams = createPlacementStreams({ transport, workspaces, queryClient, onFrame: () => undefined, onGap: () => seen.push("re-read") })
    const session = { projectId: projectId("prj_pi"), placementId: placementId("ws_cloud"), sessionId: sessionId("ses_pi") }
    const detach = streams.attach(session)
    try {
      await workspaces.load()
      await settle()
      expect(opened.map((entry) => entry.route.sessionHost)).toEqual([undefined])
      announce("root_pi")
      await settle()
      expect(opened.map((entry) => entry.route.sessionHost?.sessionId)).toEqual([undefined, "root_pi"])
      expect(opened[0]?.signal.aborted).toBe(true)
      expect(streams.streams(session)).toBe(true)
      expect(seen).toEqual(["opened workspace", "opened root_pi", "re-read"])
    } finally { detach(); streams.close(); workspaces.dispose(); queryClient.clear(); dispose() }
  })
})

test("a session stream refused because its workspace runs an older image stays closed across catalog reads, claims no status, and reopens with a re-read once its workspace's image reads current", async () => {
  const serverUrl = "http://127.0.0.1:1"
  const queryClient = new QueryClient()
  let restarted = false
  const seen: string[] = []
  let announce: (workspaceId: string, outdated: boolean) => void = () => undefined
  const transport = streamTransport({
    serverUrl,
    runtime: async () => {
      seen.push(restarted ? "opened" : "refused")
      return restarted ? openBody() : Response.json({ error: { code: "cloud_runtime_image_outdated" } }, { status: 409 })
    },
    onRuntimeImage: (listener: typeof announce) => {
      announce = listener
      return () => undefined
    },
  })
  const streams = createPlacementStreams({ transport, workspaces, queryClient, onFrame: () => undefined, onGap: () => seen.push("re-read") })
  const detach = streams.attach(ref("ses_outdated"))
  try {
    await settle()
    await Bun.sleep(600)
    expect(seen).toEqual(["refused"])
    expect(streams.streams(ref("ses_outdated")), "a refused stream delivers no status, so the hosted notices must").toBe(false)
    queryClient.setQueryData(queryKeys.bootstrap(serverUrl), { revision: 1 })
    queryClient.setQueryData(queryKeys.bootstrap(serverUrl), { revision: 2 })
    await settle()
    expect(seen).toEqual(["refused"])
    restarted = true
    announce("ws_other", false)
    await settle()
    expect(seen).toEqual(["refused"])
    announce(record.route.workspaceId, false)
    await settle()
    expect(seen).toEqual(["refused", "opened", "re-read"])
    expect(streams.streams(ref("ses_outdated"))).toBe(true)
  } finally { detach(); streams.close(); queryClient.clear() }
})
