/// <reference types="bun" />
import { expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { createRoot } from "solid-js"
import { createHostedAccount } from "./account"
import { projectId } from "./ids"
import { projectQueries } from "./projects"
import type { Transport } from "./transport"
import { createWorkspaces } from "./workspaces"

const bootstrap = {
  deployment: { serverKind: "daemon", issuesSessions: false },
  project: [{ id: "local_app", worktree: "/Users/ada/app", workspaces: { "/Users/ada/app": { id: "ws_shared", directory: "/Users/ada/app", reachable: true } } }],
}

const projects = { projects: [{ id: "local_app", name: "app", available: true, created_at: 1, updated_at: 2 }] }

const provisioned = { workspaces: [{ workspace_id: "ws_cloud", project_id: "prj_app", backing: "cloud-vm", reachable: true, display_name: "main" }, { workspace_id: "ws_web", project_id: "prj_web", backing: "cloud-vm", repo_name: "ada/web", created_at: 5, updated_at: 6 }] }
const machines = { workspaces: [{ workspace_id: "ws_shared", project_id: "prj_app", backing: "local-worktree", placement: { host_enrollment_id: "enr_this" } }] }

function transport(): Transport {
  const answers: Record<string, unknown> = { "/api/claxedo/bootstrap": bootstrap, "/api/claxedo/projects": projects }
  return { serverUrl: "http://127.0.0.1:1", loopback: true, json: async (path: string) => answers[path] } as Pick<Transport, "serverUrl" | "loopback" | "json"> as Transport
}

function world(run: (operation: string) => Promise<unknown>, gcTime?: number) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, ...(gcTime === undefined ? {} : { gcTime }) } } })
  const calls: string[] = []
  const account = createHostedAccount(async (operation) => (calls.push(operation), operation === "session.shared.list" ? { sessions: [] } : run(operation)))
  const workspaces = createWorkspaces(transport(), queryClient, account)
  return { queryClient, calls, workspaces, projects: projectQueries(transport(), workspaces) }
}

test("signed desktop catalog: the account's cloud workspace joins the local project it shares a workspace with", async () => {
  await createRoot(async (dispose) => {
    const { calls, workspaces } = world(async (operation) => (operation === "workspace.list.machine" ? machines : provisioned))
    await workspaces.load()
    expect(calls.toSorted()).toEqual(["session.shared.list", "workspace.list.machine", "workspace.list.provisioner"])
    expect(workspaces.list().map((placement) => [String(placement.id), String(placement.projectId), placement.kind])).toEqual([
      ["ws_shared", "local_app", "folder"],
      ["ws_cloud", "local_app", "cloud"],
      ["ws_web", "prj_web", "cloud"],
    ])
    expect(workspaces.accountProjectIds(projectId("local_app"))).toEqual([projectId("prj_app")])
    workspaces.dispose()
    dispose()
  })
})

test("signed desktop catalog: the account's catalog is asked while the bootstrap is still answering", async () => {
  await createRoot(async (dispose) => {
    let answer = () => {}
    const answered = new Promise<void>((resolve) => { answer = resolve })
    const slow = { ...transport(), json: async (path: string) => { await answered; return path === "/api/claxedo/bootstrap" ? bootstrap : projects } } as Transport
    const calls: string[] = []
    const account = createHostedAccount(async (operation) => (calls.push(operation), operation === "session.shared.list" ? { sessions: [] } : operation === "workspace.list.machine" ? machines : provisioned))
    const workspaces = createWorkspaces(slow, new QueryClient({ defaultOptions: { queries: { retry: false } } }), account)
    const loaded = workspaces.load()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls.toSorted()).toEqual(["session.shared.list", "workspace.list.machine", "workspace.list.provisioner"])
    answer()
    await loaded
    expect(workspaces.list()).toHaveLength(3)
    workspaces.dispose()
    dispose()
  })
})

test("signed desktop catalog: the project list gains the control-plane-only project, readable by id", async () => {
  await createRoot(async (dispose) => {
    const { queryClient, projects } = world(async (operation) => (operation === "workspace.list.machine" ? machines : provisioned))
    const listed = await queryClient.fetchQuery(projects.list())
    expect(listed.map((project) => String(project.id))).toEqual(["local_app", "prj_web"])
    expect(await queryClient.fetchQuery(projects.byId(projectId("prj_web")))).toMatchObject({ id: "prj_web", name: "ada/web", createdAt: 5 })
    dispose()
  })
})

test("signed desktop catalog: an account that cannot answer leaves this machine's placements", async () => {
  await createRoot(async (dispose) => {
    const { workspaces } = world(async () => Promise.reject(new Error("HOSTED_HTTP 503 {\"detail\":\"down\",\"body\":null}")))
    const errors: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => void errors.push(args)
    try {
      await workspaces.load()
    } finally {
      console.error = original
    }
    expect(workspaces.list().map((placement) => String(placement.id))).toEqual(["ws_shared"])
    expect(errors).toHaveLength(1)
    dispose()
  })
})

test("signed desktop catalog: the account's placements stay in the catalog once the query cache's collection time has passed", async () => {
  await createRoot(async (dispose) => {
    const { calls, workspaces } = world(async (operation) => (operation === "workspace.list.machine" ? machines : provisioned), 1)
    await workspaces.load()
    await Bun.sleep(20)
    expect(workspaces.list().map((placement) => String(placement.id))).toEqual(["ws_shared", "ws_cloud", "ws_web"])
    expect(workspaces.accountProjectIds(projectId("local_app"))).toEqual([projectId("prj_app")])
    await workspaces.load()
    expect(calls.toSorted()).toEqual(["session.shared.list", "workspace.list.machine", "workspace.list.provisioner"])
    workspaces.dispose()
    dispose()
  })
})
