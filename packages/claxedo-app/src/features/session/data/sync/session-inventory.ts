import { useGlobalSync } from "@/features/session/app-ports"
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

export function inventorySessionId(input: unknown) {
  const row = inventoryRecord(input)
  return inventoryText(row?.session_id)
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
  }
}

export function loadSessionInventory(input: SessionInventoryCompatSource) {
  return input.inventoryActions?.load?.()
}

/**
 * The inventory snapshot's only remaining reader: it seeds which rail sections
 * open on load. Every rendered row comes from the section's own source
 * (`session-source.ts`), so nothing here paginates or reloads.
 */
export function useSessionInventoryActions() {
  const source = useGlobalSync()
  return {
    load: () => loadSessionInventory(source),
  }
}
