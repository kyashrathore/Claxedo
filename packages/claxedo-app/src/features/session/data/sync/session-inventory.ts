import { useGlobalSync } from "@/features/session/app-ports"
import type { SessionFilter } from "../../../../platform/sync/global-sync/session-filter"
export {
  removeSessionInventoryQueryData,
  removeSessionInventorySession,
} from "./inventory-writers"

export function inventoryRecord(input: unknown) {
  return input && typeof input === "object" ? input as Record<string, unknown> : undefined
}

export function inventoryText(input: unknown) {
  return typeof input === "string" ? input : undefined
}

export function inventorySessionAttachments(input: unknown) {
  if (!Array.isArray(input)) return []
  return input.flatMap((item) => {
    const row = inventoryRecord(item)
    const kind = inventoryText(row?.kind)
    const targetID = inventoryText(row?.targetID) ?? inventoryText(row?.target_id)
    return kind && targetID ? [{ kind, targetID }] : []
  })
}

export function inventorySessionEnvironment(input: unknown) {
  const row = inventoryRecord(input)
  if (!row) return
  const kind = inventoryText(row.kind)
  const driver = inventoryText(row.driver) ?? inventoryText(row.provider)
  if (!kind && !driver) return
  return { ...(kind ? { kind } : {}), ...(driver ? { driver } : {}) }
}

export function inventorySessionGit(input: unknown) {
  const row = inventoryRecord(input)
  if (!row) return
  const repo = inventoryText(row.repo)
  const branch = inventoryText(row.branch)
  const remote = inventoryText(row.remote)
  if (!repo && !branch && !remote) return
  return { ...(repo ? { repo } : {}), ...(branch ? { branch } : {}), ...(remote ? { remote } : {}) }
}

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

export function reloadSessionInventory(
  input: SessionInventoryCompatSource,
  filter?: SessionFilter,
) {
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
  return input.source.inventoryActions?.loadMore?.(
    input.projectID,
    input.projectWorktree,
    input.sandboxes,
  )
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
