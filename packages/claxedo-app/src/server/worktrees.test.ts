/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { HostedAccount } from "./account"
import { machineId, placementId, projectId, type PlacementId } from "./ids"
import type { Machine } from "./machine-types"
import type { Transport } from "./transport"
import type { Placement } from "./types"
import type { Workspaces } from "./workspaces"
import { WORKTREE_ROUTE } from "./wire/placements"
import { createWorktreeCreator } from "./worktrees"

const project = projectId("prj_app")
const box = machineId("enr_box")
const buildBox = { id: box, name: "build-box", online: true, isThisMachine: false, enrolled: true, enrollment: { hostId: "host_box", enrollmentId: "enr_box", lastSeenAt: 1, servingWorkspaceIds: ["ws_app"] } } satisfies Machine
const remote: Placement = { id: placementId("ws_app"), projectId: project, kind: "folder", label: "app", path: "/home/ada/app", machineId: box, onThisMachine: false, reachable: true }
const local: Placement = { id: placementId("ws_local"), projectId: project, kind: "folder", label: "local", path: "/Users/me/app", onThisMachine: true, reachable: true }

function world() {
  const runs: Array<[string, Readonly<Record<string, unknown>>]> = []
  const posted: string[] = []
  const listed = new Map<PlacementId, Placement>([[remote.id, remote], [local.id, local]])
  const account = {
    run: async (operation: string, input: Readonly<Record<string, unknown>>) => {
      runs.push([operation, input])
      if (operation === "machines.worktree") return { directory: "/home/ada/.claxedo/worktree/prj_app/fix", branch: "claxedo/fix", name: "fix" }
      const id = placementId(String(input.workspaceId))
      listed.set(id, { ...remote, id, kind: "worktree", label: "fix", path: String(input.remoteDirectory) })
      return { assignment: { assigned: true } }
    },
  } as unknown as HostedAccount
  const workspaces = {
    byId: (id: PlacementId) => listed.get(id),
    refresh: async () => {},
    route: async () => ({ workspaceId: "ws_local" }),
    address: { placementFor: (directory: string) => (directory === "/Users/me/.claxedo/worktree/prj_app/wt" ? { placementId: local.id } : undefined) },
  } as unknown as Workspaces
  const transport = {
    json: async (path: string) => {
      posted.push(path)
      return { directory: "/Users/me/.claxedo/worktree/prj_app/wt" }
    },
  } as unknown as Transport
  const create = createWorktreeCreator(transport, workspaces, { account, machines: async () => [buildBox] })
  return { create, runs, posted }
}

test("a worktree of a connected machine's folder is made there and assigned as a new workspace of the folder's project, on its branch", async () => {
  const { create, runs, posted } = world()
  const made = await create(remote.id, { baseRef: "main" })
  expect(posted).toEqual([])
  expect(runs[0]).toEqual(["machines.worktree", { enrollmentId: "enr_box", repository: "/home/ada/app", projectId: "prj_app", baseRef: "main" }])
  expect(runs[1]?.[0]).toBe("machines.assign")
  expect(runs[1]?.[1]).toEqual({
    workspaceId: expect.stringMatching(/^ws_[0-9a-f]{32}$/),
    hostId: "host_box",
    displayName: "fix",
    repoName: "fix",
    remoteDirectory: "/home/ada/.claxedo/worktree/prj_app/fix",
    projectId: "prj_app",
    gitBranch: "claxedo/fix",
  })
  expect(made.id).toBe(placementId(String(runs[1]?.[1].workspaceId)))
})

test("a worktree of this machine's folder stays the local server's own", async () => {
  const { create, runs, posted } = world()
  const made = await create(local.id, {})
  expect(runs).toEqual([])
  expect(posted).toEqual([`${WORKTREE_ROUTE}?workspaceId=ws_local`])
  expect(made.id).toBe(local.id)
})
