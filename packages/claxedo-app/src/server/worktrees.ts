import { readString } from "@claxedo/helpers/readers"
import { ServerError } from "./errors"
import type { PlacementsApi } from "./api"
import { jsonInit, withQuery, type Transport } from "./transport"
import type { Workspaces } from "./workspaces"
import { WORKTREE_ROUTE } from "./wire/placements"

export function createWorktreeCreator(transport: Transport, workspaces: Workspaces): PlacementsApi["createWorktree"] {
  return async (projectId, input) => {
    const root = workspaces.list().find((placement) => placement.projectId === projectId && placement.kind === "folder")
    if (!root) throw new ServerError({ class: "not_found", message: `Project ${projectId} has no folder placement to branch from` })
    const at = withQuery(WORKTREE_ROUTE, { workspaceId: (await workspaces.route(root.id)).workspaceId })
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
}
