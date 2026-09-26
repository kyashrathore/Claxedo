import { asRecord } from "@claxedo/helpers/guards"
import type { PluginChange, PluginSourceRecord } from "../marketplace-types"

const SOURCE_KINDS: readonly PluginSourceRecord["kind"][] = ["claxedo", "personal", "organization"]

export function pluginChangeFromWire(value: unknown): PluginChange | undefined {
  const row = asRecord(value)
  const reconciliation = asRecord(row?.reconciliation)
  if (!row || typeof row.revision !== "number" || !Number.isSafeInteger(row.revision) || typeof reconciliation?.state !== "string") return undefined
  const message = typeof reconciliation.message === "string" ? reconciliation.message : undefined
  return { revision: row.revision, reconciliation: { state: reconciliation.state, ...(message ? { message } : {}) } }
}

export function pluginSourceFromWire(value: unknown): PluginSourceRecord | undefined {
  const row = asRecord(value)
  const kind = SOURCE_KINDS.find((candidate) => candidate === row?.kind)
  if (!row || !kind) return undefined
  const { id, label, repository, ref, canRemove } = row
  if (typeof id !== "string" || typeof label !== "string" || typeof repository !== "string" || typeof ref !== "string" || typeof canRemove !== "boolean") return undefined
  const authority = row.authority === "user" || row.authority === "organization" ? row.authority : undefined
  return { id, kind, label, repository, ref, ...(authority ? { authority } : {}), canRemove }
}

export function pluginSourcesFromWire(value: unknown): readonly PluginSourceRecord[] | undefined {
  const rows = asRecord(value)?.sources
  if (!Array.isArray(rows)) return undefined
  return rows.flatMap((row) => {
    const source = pluginSourceFromWire(row)
    return source ? [source] : []
  })
}
