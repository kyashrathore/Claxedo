import { useGlobalSync } from "@/features/session/app-ports"
import type { SessionFilter } from "../../../../platform/sync/global-sync/session-filter"
export { removeSessionInventoryQueryData, removeSessionInventorySession } from "./inventory-writers"

type SessionInventoryCompatSource = {
  inventoryActions?: {
    load?: () => Promise<unknown> | unknown
    reloadWorkspace?: (filter?: SessionFilter) => Promise<unknown> | unknown
    loadMore?: (projectID: string, projectWorktree: string, sandboxes: string[]) => Promise<unknown> | unknown
    loadMoreWorkspace?: (directory: string, filter?: SessionFilter) => Promise<unknown> | unknown
  }
}

export function loadSessionInventory(input: SessionInventoryCompatSource) {
  return input.inventoryActions?.load?.()
}

export function reloadSessionInventory(input: SessionInventoryCompatSource, filter?: SessionFilter) {
  return input.inventoryActions?.reloadWorkspace?.(filter)
}

export function loadMoreSessionInventoryWorkspace(input: {
  source: SessionInventoryCompatSource
  directory: string
  filter?: SessionFilter
}) {
  return input.source.inventoryActions?.loadMoreWorkspace?.(input.directory, input.filter)
}

export function loadMoreSessionInventoryProject(input: {
  source: SessionInventoryCompatSource
  projectID: string
  projectWorktree: string
  sandboxes: string[]
}) {
  return input.source.inventoryActions?.loadMore?.(input.projectID, input.projectWorktree, input.sandboxes)
}

export function useSessionInventoryActions() {
  const source = useGlobalSync()
  return {
    load: () => loadSessionInventory(source),
    reloadWorkspace: (filter?: SessionFilter) => reloadSessionInventory(source, filter),
    loadMoreProject: (input: { projectID: string; projectWorktree: string; sandboxes: string[] }) =>
      loadMoreSessionInventoryProject({
        source,
        projectID: input.projectID,
        projectWorktree: input.projectWorktree,
        sandboxes: input.sandboxes,
      }),
    loadMoreWorkspace: (input: { directory: string; filter?: SessionFilter }) =>
      loadMoreSessionInventoryWorkspace({
        source,
        directory: input.directory,
        filter: input.filter,
      }),
  }
}
