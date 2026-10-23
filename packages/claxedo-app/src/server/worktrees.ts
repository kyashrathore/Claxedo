import { readString } from "@claxedo/helpers/readers"
import type { HostedAccount } from "./account"
import { ServerError } from "./errors"
import type { PlacementsApi } from "./api"
import type { WorktreeCreateInput } from "./git-types"
import { assignOnMachine, machineHostId } from "./machine-projects"
import type { Machine } from "./machine-types"
import { jsonInit, withQuery, type Transport } from "./transport"
import type { Placement } from "./types"
import type { Workspaces } from "./workspaces"
import { WORKTREE_ROUTE } from "./wire/placements"

export type MachineWorktrees = { readonly account: HostedAccount | undefined; readonly machines: () => Promise<readonly Machine[]> }

async function machineWorktree(target: MachineWorktrees, workspaces: Workspaces, root: Placement, input: WorktreeCreateInput): Promise<Placement> {
  const machine = root.machineId
  if (!target.account || !machine || !root.path) {
    throw new ServerError({ class: "invalid", message: "A worktree on another machine needs a signed-in account and the folder's path there" })
  }
  const hostId = await machineHostId(target.machines, machine)
  const made = await target.account.run("machines.worktree", {
    enrollmentId: machine,
    repository: root.path,
    projectId: root.projectId,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.baseRef !== undefined ? { baseRef: input.baseRef } : {}),
  })
  const directory = readString(made, "directory")
  const branch = readString(made, "branch")
  const name = readString(made, "name")
  if (!directory || !branch || !name) throw new ServerError({ class: "internal", message: "The machine did not name the worktree it made" })
  return assignOnMachine(target.account, workspaces, { hostId, directory, name, projectId: root.projectId, gitBranch: branch })
}

async function localWorktree(transport: Transport, workspaces: Workspaces, root: Placement["id"], input: WorktreeCreateInput): Promise<Placement> {
  const at = withQuery(WORKTREE_ROUTE, { workspaceId: (await workspaces.route(root)).workspaceId })
  const directory = readString(await transport.json(at, jsonInit("POST", {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.baseRef !== undefined ? { baseRef: input.baseRef } : {}),
  })), "directory")
  if (directory === undefined) throw new ServerError({ class: "internal", message: "The worktree create answered without a directory" })
  await workspaces.refresh()
  const placed = workspaces.address.placementFor(directory)
  const placement = placed ? workspaces.byId(placed.placementId) : undefined
  if (!placement) throw new ServerError({ class: "internal", message: `The catalog does not list the new worktree at ${directory}` })
  return placement
}

export function createWorktreeCreator(transport: Transport, workspaces: Workspaces, machines: MachineWorktrees): PlacementsApi["createWorktree"] {
  return async (root, input) => {
    const placement = workspaces.byId(root)
    return placement && !placement.onThisMachine && placement.machineId !== undefined
      ? machineWorktree(machines, workspaces, placement, input)
      : localWorktree(transport, workspaces, root, input)
  }
}
