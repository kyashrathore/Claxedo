/// <reference types="bun" />
import { expect, test } from "bun:test"
import { linkAccountCatalog } from "./account-link"
import { projectId } from "./ids"
import { accountCatalogFromWire } from "./wire/account-catalog"
import { bootstrapCatalog } from "./wire/placements"

const local = bootstrapCatalog({
  deployment: { serverKind: "daemon" },
  host: { enrollment: "enr_this" },
  project: [
    {
      id: "local_app",
      worktree: "/Users/ada/app",
      workspaces: { "/Users/ada/app": { id: "ws_shared", directory: "/Users/ada/app", backing: "local-worktree", reachable: true, placement: { host_enrollment_id: "enr_this" } } },
    },
    { id: "local_notes", worktree: "/Users/ada/notes", workspaces: { "/Users/ada/notes": { id: "ws_notes", directory: "/Users/ada/notes", reachable: true } } },
  ],
}).placements

type Row = { workspace_id: string; project_id: string; backing: "local-worktree" | "cloud-vm"; reachable: boolean; created_at: number; updated_at: number; repo_url?: string; display_name?: string }

function row(workspace: string, project: string, backing: Row["backing"], reachable: boolean, at: number, repository = "https://github.com/ada/app.git"): Row {
  return { workspace_id: workspace, project_id: project, backing, reachable, created_at: at, updated_at: at + 10, repo_url: repository, display_name: "main" }
}

const account = accountCatalogFromWire([
  row("ws_shared", "prj_app", "local-worktree", true, 10),
  row("ws_cloud", "prj_app", "cloud-vm", false, 10),
  row("ws_web", "prj_web", "cloud-vm", true, 30, "https://github.com/ada/web.git"),
])

test("account link: a control-plane project sharing a local workspace id is that local project", () => {
  const linked = linkAccountCatalog(local, account)
  const cloud = linked.placements.find((record) => String(record.placement.id) === "ws_cloud")
  expect(cloud?.placement).toMatchObject({ projectId: "local_app", kind: "cloud", reachable: false })
  expect(cloud?.route).toEqual({ kind: "cloud", directory: "workspace:ws_cloud", workspaceId: "ws_cloud", remote: true })
  expect(linked.projects.map((project) => project.id)).toEqual([projectId("prj_web")])
  expect(linked.accountProjectIds(projectId("local_app"))).toEqual([projectId("prj_app")])
})

test("account link: the shared workspace keeps its local placement; the control plane's copy is dropped", () => {
  const linked = linkAccountCatalog(local, account)
  expect(linked.placements.map((record) => String(record.placement.id))).toEqual(["ws_cloud", "ws_web"])
})

test("account link: a control-plane-only project stands as its own project with its own placements", () => {
  const linked = linkAccountCatalog(local, account)
  expect(linked.projects).toEqual([
    { id: projectId("prj_web"), name: "ada/web", source: { kind: "repository", url: "https://github.com/ada/web.git" }, available: true, env: {}, createdAt: 30, updatedAt: 40 },
  ])
  expect(linked.placements.find((record) => String(record.placement.id) === "ws_web")?.placement.projectId).toBe(projectId("prj_web"))
  expect(linked.accountProjectIds(projectId("prj_web"))).toEqual([projectId("prj_web")])
  expect(linked.accountProjectIds(projectId("local_notes"))).toEqual([])
})

test("account link: a control-plane project with a local project's own id pairs with it", () => {
  const same = accountCatalogFromWire([row("ws_remote", "local_notes", "cloud-vm", true, 50)])
  const linked = linkAccountCatalog(local, same)
  expect(linked.projects).toEqual([])
  expect(linked.placements[0]?.placement.projectId).toBe(projectId("local_notes"))
})

test("account link: every account placement is a remote workspace, and a machine's keeps its host and path", () => {
  const machine = accountCatalogFromWire([{ ...row("ws_node", "prj_node", "local-worktree", true, 60), remote_directory: "/srv/app", placement: { host_enrollment_id: "enr_other" } }])
  expect(machine.placements[0]?.route).toEqual({ kind: "worktree", directory: "workspace:ws_node", workspaceId: "ws_node", remote: true })
  expect(machine.placements[0]?.placement).toMatchObject({ kind: "worktree", path: "/srv/app", machineId: "enr_other" })
})

test("account catalog: a project without a named row takes its repository, then its workspace's name", () => {
  const named = accountCatalogFromWire([{ workspace_id: "ws_1", project_id: "prj_1", backing: "cloud-vm", display_name: "main" }])
  expect(named.projects[0]?.name).toBe("main")
  expect(accountCatalogFromWire([row("ws_2", "prj_2", "cloud-vm", true, 1, "git@github.com:ada/tools.git")]).projects[0]?.name).toBe("ada/tools")
  expect(accountCatalogFromWire([row("ws_1", "prj_1", "cloud-vm", true, 1), row("ws_1", "prj_1", "cloud-vm", true, 1)]).placements).toHaveLength(1)
})

test("account link: an empty account catalog pairs nothing", () => {
  const linked = linkAccountCatalog(local, accountCatalogFromWire([]))
  expect({ placements: linked.placements, projects: linked.projects }).toEqual({ placements: [], projects: [] })
})
