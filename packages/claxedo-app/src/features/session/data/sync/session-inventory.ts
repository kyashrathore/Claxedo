import { useGlobalSync } from "@/features/session/app-ports"
import { asRecord } from "@/lib/record"
export {
  removeSessionInventoryQueryData,
  removeSessionInventorySession,
} from "./inventory-writers"

export function inventoryText(input: unknown) {
  return typeof input === "string" ? input : undefined
}

export function inventorySessionId(input: unknown) {
  const row = asRecord(input)
  return inventoryText(row?.session_id)
}

export function inventorySessionAttachments(input: unknown) {
  if (!Array.isArray(input)) return []
  return input.flatMap((item) => {
    const row = asRecord(item)
    const kind = inventoryText(row?.kind)
    const targetID = inventoryText(row?.targetID) ?? inventoryText(row?.target_id)
    return kind && targetID ? [{ kind, targetID }] : []
  })
}

export function inventorySessionEnvironment(input: unknown) {
  const row = asRecord(input)
  if (!row) return undefined
  const kind = inventoryText(row.kind)
  const driver = inventoryText(row.driver) ?? inventoryText(row.provider)
  if (!kind && !driver) return undefined
  return { ...(kind ? { kind } : {}), ...(driver ? { driver } : {}) }
}

export function inventorySessionGit(input: unknown) {
  const row = asRecord(input)
  if (!row) return undefined
  const repo = inventoryText(row.repo)
  const branch = inventoryText(row.branch)
  const remote = inventoryText(row.remote)
  if (!repo && !branch && !remote) return undefined
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
