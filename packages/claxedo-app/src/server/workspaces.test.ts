/// <reference types="bun" />
import { expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { createRoot } from "solid-js"
import { placementId, projectId } from "./ids"
import type { Transport } from "./transport"
import { createWorkspaces } from "./workspaces"
import { queryKeys } from "./query-keys"
import { invalidateFor } from "./queries"

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

test("a machine start the server tells of re-reads the catalog, so a start this app did not ask for reads starting", async () => {
  await createRoot(async (dispose) => {
    let status = "stopped"
    const reads: string[] = []
    const cloudRow = () => ({ id: "ws_cloud", backing: "cloud-vm", workspace_name: "main", directory: "workspace:ws_cloud", status, reachable: status === "ready" })
    const server = {
      serverUrl: "http://127.0.0.1:1",
      loopback: false,
      json: async (path: string) => {
        reads.push(path)
        return { deployment: { serverKind: "daemon", issuesSessions: true }, project: [{ id: "proj_one", worktree: "ws_cloud", workspaces: { ws_cloud: cloudRow() } }] }
      },
      onSessionHost: () => () => undefined,
    } as Pick<Transport, "serverUrl" | "loopback" | "json" | "onSessionHost"> as Transport
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const workspaces = createWorkspaces(server, queryClient)
    await workspaces.load()
    const cloud = () => workspaces.byId(placementId("ws_cloud"))
    expect(cloud()).toMatchObject({ kind: "cloud", lifecycle: "asleep" })

    status = "provisioning"
    invalidateFor(queryClient, server.serverUrl, { type: "cloudWorkspaceChanged", workspaceId: placementId("ws_cloud"), status: { kind: "provisioning", step: "starting" } }, false)
    for (let tick = 0; tick < 50 && reads.length < 2; tick += 1) await Bun.sleep(1)
    await Bun.sleep(1)
    expect(reads.length).toBe(2)
    expect(cloud()).toMatchObject({ kind: "cloud", lifecycle: "starting" })
    workspaces.dispose()
    dispose()
  })
})
