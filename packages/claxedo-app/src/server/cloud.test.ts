/// <reference types="bun" />
import { expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { createRoot } from "solid-js"
import { createHostedAccount } from "./account"
import { cloudQueries, createCloudApi } from "./cloud"
import { placementId, projectId, type ProjectId } from "./ids"
import type { Transport } from "./transport"
import type { Project } from "./types"
import type { WorkspaceWakes } from "./workspace-wakes"
import { createWorkspaces } from "./workspaces"

const bootstrap = { deployment: { serverKind: "daemon", issuesSessions: false }, project: [] }
const created = { workspace_id: "ws_new", project_id: "prj_widgets", backing: "cloud-vm", repo_url: "https://github.com/acme/widgets", workspace_name: "Widgets", status: "provisioning" }
const wakes: WorkspaceWakes = {
  runtime: () => ({ kind: "live" }),
  start: async () => undefined,
  wakeIfStopped: async () => false,
  settle: async () => false,
}

type Posted = { readonly path: string; readonly body: unknown }

function transport(posted: Posted[], provisioned: Set<string>): Transport {
  const json = async (path: string, init?: RequestInit) => {
    if (path === "/api/claxedo/bootstrap") return bootstrap
    if (path === "/api/workspace?host=provisioner") return { workspaces: [...provisioned].map((id) => ({ ...created, workspace_id: id })) }
    if (init?.method === "DELETE" && path.startsWith("/api/workspace/")) {
      posted.push({ path, body: "DELETE" })
      provisioned.delete(decodeURIComponent(path.slice("/api/workspace/".length)))
      return { deleted: true }
    }
    if (path !== "/api/workspace/create") throw new Error(`unexpected ${path}`)
    posted.push({ path, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body })
    return { workspaceId: "ws_new", directory: "/workspace/widgets" }
  }
  return { serverUrl: "http://127.0.0.1:1", loopback: true, json, onSessionHost: () => () => undefined } as Pick<Transport, "serverUrl" | "loopback" | "json" | "onSessionHost"> as Transport
}

function world(signed: boolean, catalog: () => void = () => {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const posted: Posted[] = []
  const operations: Array<{ readonly operation: string; readonly input: unknown }> = []
  let made = false
  const account = createHostedAccount(async (operation, input) => {
    operations.push({ operation, input })
    if (operation === "workspace.create") {
      made = true
      return { workspaceId: "ws_new", directory: "/workspace/widgets" }
    }
    if (operation === "workspace.list.provisioner") catalog()
    return { workspaces: operation === "workspace.list.provisioner" && made ? [created] : [] }
  })
  const provisioned = new Set<string>()
  const wire = transport(posted, provisioned)
  const workspaces = createWorkspaces(wire, queryClient, signed ? account : undefined)
  const project = async (id: ProjectId) => ({ id, source: { kind: "repository", url: "https://github.com/acme/widgets" } }) as Pick<Project, "id" | "source"> as Project
  const cloud = createCloudApi(wire, workspaces, wakes, project, signed ? account : undefined, queryClient)
  const listed = async () => (await queryClient.fetchQuery({ ...cloudQueries(wire).cloud.list(), staleTime: Infinity })).map((workspace) => workspace.id)
  return { cloud, workspaces, posted, provisioned, listed, operations: () => operations.filter((entry) => entry.operation === "workspace.create") }
}

test("signed desktop: a repository's cloud workspace is created on the account's control plane and read back from its catalog", async () => {
  await createRoot(async (dispose) => {
    const { cloud, workspaces, posted, operations } = world(true)
    const workspace = await cloud.create({ source: { kind: "repository", url: "https://github.com/acme/widgets" }, name: "Widgets" })
    expect(workspace).toMatchObject({ id: placementId("ws_new"), projectId: projectId("prj_widgets") })
    expect(operations()).toEqual([{ operation: "workspace.create", input: { workspaceName: "Widgets", repoUrl: "https://github.com/acme/widgets" } }])
    expect(posted).toEqual([])
    expect(workspaces.byId(placementId("ws_new"))?.kind).toBe("cloud")
    workspaces.dispose()
    dispose()
  })
})

test("signed desktop: a connected repository names its connection and full name in main's flat operation input", async () => {
  await createRoot(async (dispose) => {
    const { cloud, workspaces, operations } = world(true)
    await cloud.create({ source: { kind: "connectedRepository", connectionId: "gh_1", fullName: "acme/widgets" } })
    expect(operations()).toEqual([{ operation: "workspace.create", input: { connectionId: "gh_1", repoFullName: "acme/widgets" } }])
    workspaces.dispose()
    dispose()
  })
})

test("without an account the project's cloud workspace is created on this server, and a bare repository's is refused", async () => {
  await createRoot(async (dispose) => {
    const { cloud, workspaces, posted, operations } = world(false)
    await expect(cloud.create({ source: { kind: "repository", url: "https://github.com/acme/widgets" } })).rejects.toThrow("created on a signed control plane")
    const workspace = await cloud.create({ projectId: projectId("prj_widgets"), branch: "main" })
    expect(workspace).toMatchObject({ id: placementId("ws_new"), projectId: projectId("prj_widgets") })
    expect(posted).toEqual([{ path: "/api/workspace/create", body: { projectId: "prj_widgets", gitBranch: "main", repoUrl: "https://github.com/acme/widgets" } }])
    expect(operations()).toEqual([])
    workspaces.dispose()
    dispose()
  })
})

test("signed: a workspace the account created is reported before the catalog read that fails after it", async () => {
  await createRoot(async (dispose) => {
    let failing = false
    const { cloud, workspaces, operations } = world(true, () => {
      if (failing) throw new Error("catalog unavailable")
    })
    const reported: string[] = []
    failing = true
    await expect(cloud.create({ source: { kind: "repository", url: "https://github.com/acme/widgets" }, onCreated: (id) => reported.push(id) })).rejects.toThrow()
    expect(reported).toEqual([placementId("ws_new")])
    expect(operations()).toHaveLength(1)
    workspaces.dispose()
    dispose()
  })
})

test("deleting a cloud workspace sends DELETE for it and the cloud list read after it no longer has it", async () => {
  await createRoot(async (dispose) => {
    const { cloud, workspaces, posted, provisioned, listed } = world(false)
    provisioned.add("ws_gone")
    provisioned.add("ws_kept")
    expect(await listed()).toEqual([placementId("ws_gone"), placementId("ws_kept")])
    await cloud.remove(placementId("ws_gone"))
    expect(posted).toEqual([{ path: "/api/workspace/ws_gone", body: "DELETE" }])
    expect(await listed()).toEqual([placementId("ws_kept")])
    workspaces.dispose()
    dispose()
  })
})
