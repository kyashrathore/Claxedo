/// <reference types="bun" />
import { expect, test } from "bun:test"
import { linkAccountCatalog } from "./account-link"
import { projectId } from "./ids"
import { accountCatalogFromWire } from "./wire/account-catalog"
import { bootstrapCatalog } from "./wire/placements"

const local = bootstrapCatalog({
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

function cpWorkspace(id: string, backing: "local-worktree" | "cloud-vm", reachable: boolean) {
  return { id, backing, workspace_name: id, reachable, directory: `workspace:${id}`, repo_url: "https://github.com/ada/app.git" }
}

const account = accountCatalogFromWire([
  {
    id: "prj_app",
    name: "ada/app",
    worktree: "ws_shared",
    time: { created: 10, updated: 20 },
    workspaces: { ws_shared: cpWorkspace("ws_shared", "local-worktree", true), ws_cloud: cpWorkspace("ws_cloud", "cloud-vm", false) },
  },
  { id: "prj_web", name: "ada/web", worktree: "ws_web", time: { created: 30, updated: 40 }, workspaces: { ws_web: cpWorkspace("ws_web", "cloud-vm", true) } },
])

test("account link: a control-plane project sharing a local workspace id is that local project", () => {
  const linked = linkAccountCatalog(local, account)
  const cloud = linked.placements.find((record) => String(record.placement.id) === "ws_cloud")
  expect(cloud?.placement).toMatchObject({ projectId: "local_app", kind: "cloud", reachable: false })
  expect(cloud?.route).toEqual({ directory: "workspace:ws_cloud", workspaceId: "ws_cloud", remote: true })
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
    { id: projectId("prj_web"), name: "ada/web", source: { kind: "repository", url: "https://github.com/ada/app.git" }, available: true, env: {}, createdAt: 30, updatedAt: 40 },
  ])
  expect(linked.placements.find((record) => String(record.placement.id) === "ws_web")?.placement.projectId).toBe(projectId("prj_web"))
  expect(linked.accountProjectIds(projectId("prj_web"))).toEqual([projectId("prj_web")])
  expect(linked.accountProjectIds(projectId("local_notes"))).toEqual([])
})

test("account link: a control-plane project with a local project's own id pairs with it", () => {
  const same = accountCatalogFromWire([{ id: "local_notes", name: "notes", workspaces: { ws_remote: cpWorkspace("ws_remote", "cloud-vm", true) } }])
  const linked = linkAccountCatalog(local, same)
  expect(linked.projects).toEqual([])
  expect(linked.placements[0]?.placement.projectId).toBe(projectId("local_notes"))
})

test("account link: an empty account catalog pairs nothing", () => {
  const linked = linkAccountCatalog(local, accountCatalogFromWire([]))
  expect({ placements: linked.placements, projects: linked.projects }).toEqual({ placements: [], projects: [] })
})
