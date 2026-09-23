import { useGlobalSync } from "@/features/session/app-ports"
import { asRecord, asString } from "@claxedo/helpers/guards"
export {
  removeSessionInventoryQueryData,
  removeSessionInventorySession,
} from "./inventory-writers"

export function inventorySessionId(input: unknown) {
  const row = asRecord(input)
  return asString(row?.session_id)
}

export function inventorySessionAttachments(input: unknown) {
  if (!Array.isArray(input)) return []
  return input.flatMap((item) => {
    const row = asRecord(item)
    const kind = asString(row?.kind)
    const targetID = asString(row?.targetID) ?? asString(row?.target_id)
    return kind && targetID ? [{ kind, targetID }] : []
  })
}

export function inventorySessionEnvironment(input: unknown) {
  const row = asRecord(input)
  if (!row) return undefined
  const kind = asString(row.kind)
  const driver = asString(row.driver) ?? asString(row.provider)
  if (!kind && !driver) return undefined
  return { ...(kind ? { kind } : {}), ...(driver ? { driver } : {}) }
}

export function inventorySessionGit(input: unknown) {
  const row = asRecord(input)
  if (!row) return undefined
  const repo = asString(row.repo)
  const branch = asString(row.branch)
  const remote = asString(row.remote)
  if (!repo && !branch && !remote) return undefined
  return { ...(repo ? { repo } : {}), ...(branch ? { branch } : {}), ...(remote ? { remote } : {}) }
}

type SessionInventoryCompatSource = {
  inventoryActions?: {
    load?: () => unknown
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
