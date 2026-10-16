/// <reference types="bun" />
import { expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { createRoot } from "solid-js"
import { placementId, projectId } from "./ids"
import type { Transport } from "./transport"
import { createWorkspaces } from "./workspaces"
import { queryKeys } from "./query-keys"
import { invalidateFor } from "./queries"
import { frameFromWire, serverEventFromFrame } from "./wire/frames"
import type { ServerEvent } from "./events"

const bootstrap = {
  deployment: { serverKind: "daemon", issuesSessions: false },
  project: [{ id: "local_app", worktree: "/Users/ada/app", workspaces: { "/Users/ada/app": { id: "ws_app", directory: "/Users/ada/app", reachable: true } } }],
}

function transport(reads: string[]): Transport {
  return {
    serverUrl: "http://127.0.0.1:1",
    loopback: true,
    json: async (path: string) => (reads.push(path), bootstrap),
    onSessionHost: () => () => undefined,
  } as Pick<Transport, "serverUrl" | "loopback" | "json" | "onSessionHost"> as Transport
}

test("the placement catalog stays readable once the query cache's collection time has passed with nothing reading it", async () => {
  await createRoot(async (dispose) => {
    const reads: string[] = []
    const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 1, retry: false } } })
    const workspaces = createWorkspaces(transport(reads), queryClient)
    await workspaces.load()
    await Bun.sleep(20)
    expect(workspaces.byId(placementId("ws_app"))?.projectId).toBe(projectId("local_app"))
    expect(workspaces.list().map((placement) => String(placement.id))).toEqual(["ws_app"])
    await workspaces.load()
    expect(reads).toEqual(["/api/claxedo/bootstrap"])
    const cloudKey = queryKeys.cloud("http://127.0.0.1:1")
    queryClient.setQueryData(cloudKey, [])
    await workspaces.refresh()
    expect(queryClient.getQueryState(cloudKey)?.isInvalidated).toBe(true)
    workspaces.dispose()
    dispose()
  })
})

async function cloudCatalog(status: { current: string }) {
  const reads: string[] = []
  const server = {
    serverUrl: "http://127.0.0.1:1",
    loopback: false,
    json: async (path: string) => {
      reads.push(path)
      const row = { id: "ws_cloud", backing: "cloud-vm", workspace_name: "main", directory: "workspace:ws_cloud", status: status.current, reachable: status.current === "ready" }
      return { deployment: { serverKind: "daemon", issuesSessions: true }, project: [{ id: "proj_one", worktree: "ws_cloud", workspaces: { ws_cloud: row } }] }
    },
    onSessionHost: () => () => undefined,
  } as Pick<Transport, "serverUrl" | "loopback" | "json" | "onSessionHost"> as Transport
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const workspaces = createWorkspaces(server, queryClient)
  await workspaces.load()
  const rereadsAfter = async (event: ServerEvent) => {
    const before = reads.length
    invalidateFor(queryClient, server.serverUrl, event, false)
    for (let tick = 0; tick < 50 && reads.length === before; tick += 1) await Bun.sleep(1)
    await Bun.sleep(1)
    return reads.length - before
  }
  return { workspaces, cloud: () => workspaces.byId(placementId("ws_cloud")), rereadsAfter }
}

test("a machine start the server tells of re-reads the catalog, so a start this app did not ask for reads starting", async () => {
  await createRoot(async (dispose) => {
    const status = { current: "stopped" }
    const { workspaces, cloud, rereadsAfter } = await cloudCatalog(status)
    expect(cloud()).toMatchObject({ kind: "cloud", lifecycle: "asleep" })

    status.current = "provisioning"
    expect(await rereadsAfter({ type: "cloudWorkspaceChanged", workspaceId: placementId("ws_cloud"), status: { kind: "provisioning", step: "starting" } })).toBe(1)
    expect(cloud()).toMatchObject({ kind: "cloud", lifecycle: "starting" })
    workspaces.dispose()
    dispose()
  })
})

test("a machine stop the server tells of re-reads the catalog, so an open cloud workspace reads asleep without its stream retrying", async () => {
  await createRoot(async (dispose) => {
    const status = { current: "ready" }
    const { workspaces, cloud, rereadsAfter } = await cloudCatalog(status)
    expect(cloud()).toMatchObject({ kind: "cloud", lifecycle: "live" })

    status.current = "stopped"
    const frame = frameFromWire({ type: "provision", workspaceId: "ws_cloud", ownerUserId: "usr_owner", orgId: "org_1", step: "stopped", ts: 9 })
    const event = frame && serverEventFromFrame(frame, { placementFor: () => undefined })
    if (!event) throw new Error("the stop notice decoded to no event")
    expect(await rereadsAfter(event)).toBe(1)
    expect(cloud()).toMatchObject({ kind: "cloud", lifecycle: "asleep" })
    workspaces.dispose()
    dispose()
  })
})
