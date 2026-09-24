import { ServerError } from "./errors"
import type { PlacementsApi } from "./index"
import { jsonInit, withQuery, type Transport } from "./transport"
import type { Workspaces } from "./workspaces"

const WORKTREE_PATH = "/experimental/worktree"

export function createWorktreeCreator(transport: Transport, workspaces: Workspaces): PlacementsApi["createWorktree"] {
  return async (projectId, input) => {
    const root = workspaces.list().find((placement) => placement.projectId === projectId && placement.kind === "folder")
    if (!root) throw new ServerError({ class: "not_found", message: `Project ${projectId} has no folder placement to branch from` })
    const at = withQuery(WORKTREE_PATH, { workspaceId: (await workspaces.route(root.id)).workspaceId })
    const created = await transport.json<{ directory?: unknown }>(at, jsonInit("POST", input.name ? { name: input.name } : {}))
    if (typeof created.directory !== "string") throw new ServerError({ class: "internal", message: "The worktree create answered without a directory" })
    await workspaces.refresh()
    const placed = workspaces.address.placementFor(created.directory)
    const placement = placed ? workspaces.byId(placed.placementId) : undefined
    if (!placement) throw new ServerError({ class: "internal", message: `The catalog does not list the new worktree at ${created.directory}` })
    return placement
  }
}
