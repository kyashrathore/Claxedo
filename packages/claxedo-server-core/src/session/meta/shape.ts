import { isOneOf } from "../../platform/runtime/lib/json"
import { SESSION_ATTACHMENT_KINDS, type SessionAttachment } from "./types"
import type { Workspace } from "../../workspace/store"
import { asFiniteNumber, asRecord } from "@claxedo/helpers/guards"



export function now() {
  return Date.now()
}

export function txt(input: unknown) {
  return typeof input === "string" && input.trim() ? input.trim() : undefined
}

export function host(input: unknown) {
  return input === "workspace" ? input : undefined
}

function uniq(input: string[]) {
  return [...new Set(input)]
}

export function ids(input: string[]) {
  return uniq(input.map((item) => item.trim()).filter(Boolean))
}

export function tags(input: unknown) {
  if (!Array.isArray(input)) return undefined
  return ids(input.filter((item): item is string => typeof item === "string"))
}

export function attachments(input: unknown) {
  if (!Array.isArray(input)) return undefined
  const seen = new Set<string>()
  const out: SessionAttachment[] = []
  for (const item of input) {
    const row = asRecord(item)
    const kind = txt(row?.kind)
    const targetID = txt(row?.targetID) ?? txt(row?.target_id)
    if (!targetID || !isOneOf(kind, SESSION_ATTACHMENT_KINDS)) continue
    // Deduplicated on the pair, which is what the previous
    // stringify/uniq/parse round trip was doing.
    const key = `${kind}\u0000${targetID}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ kind, targetID })
  }
  return out
}

export function root(input: string, by: Map<string, { parentID?: string }>, seen = new Set<string>()): string {
  if (seen.has(input)) return input
  seen.add(input)
  const parentID = by.get(input)?.parentID
  if (!parentID) return input
  if (!by.has(parentID)) return parentID
  return root(parentID, by, seen)
}

/**
 * The later of a stored and an incoming human-turn stamp, `null` for "never".
 *
 * Only ever moves forward: an engine reconnecting with a snapshot taken before
 * the reader's last prompt must not erase it, and the session list orders on
 * this column.
 */
export function laterHumanTurn(incoming: number | null | undefined, stored: number | null | undefined) {
  if (incoming === null || incoming === undefined) return stored ?? null
  if (stored === null || stored === undefined) return incoming
  return Math.max(incoming, stored)
}

export function sessionModel(input: unknown): { providerID: string; modelID: string } | undefined {
  const row = asRecord(input)
  const providerID = txt(row?.providerID) ?? txt(row?.provider_id)
  const modelID = txt(row?.modelID) ?? txt(row?.model_id)
  if (!providerID || !modelID) return undefined
  return { providerID, modelID }
}

export function storedSessionRef(input: {
  session_id: string
  workspace_id?: string | null
  workspace_kind?: Workspace["kind"]
  directory?: string | null
  host?: string | null
}) {
  if (input.workspace_kind === "local") return `local:${input.directory ?? "global"}:session:${input.session_id}`
  if (input.workspace_id) return `workspace:${input.workspace_id}:session:${input.session_id}`
  return `local:${input.directory ?? "global"}:session:${input.session_id}`
}

export function sessionMetaSyncRow(input: unknown, ws?: Workspace) {
  const item = asRecord(input)
  const session_id = txt(item?.id)
  if (!session_id || (item?.host !== undefined && !host(item.host))) return undefined
  const time = stamp(item)
  const workspace_id = ws?.id ?? txt(item?.workspaceID) ?? null
  const hostValue = host(item?.host) ?? "workspace"
  const directory = txt(item?.directory) ?? ws?.directory ?? null
  return {
    session_ref: storedSessionRef({
      session_id,
      workspace_id,
      workspace_kind: ws?.kind,
      directory,
      host: hostValue,
    }),
    session_id,
    workspace_id,
    project_id: ws?.project_id ?? txt(item?.projectID) ?? null,
    host: hostValue,
    directory,
    model_provider_id: sessionModel(item?.model)?.providerID ?? null,
    model_id: sessionModel(item?.model)?.modelID ?? null,
    title: txt(item?.title) ?? txt(item?.slug) ?? null,
    parent_session_id: txt(item?.parentID),
    archived_at: time.archived ?? null,
    created_at: time.created,
    updated_at: time.updated,
    last_human_turn_at: time.lastHumanTurn ?? null,
  }
}

export function parseSessionMeta(input: unknown) {
  const row = asRecord(input)
  return {
    ...(row && "title" in row ? { title: txt(row.title) ?? null } : {}),
    ...(row && "parentID" in row ? { parentID: txt(row.parentID) ?? null } : {}),
    ...(row && "tags" in row ? { tags: tags(row.tags) ?? [] } : {}),
    ...(row && "attachments" in row ? { attachments: attachments(row.attachments) ?? [] } : {}),
  }
}

function stamp(input: unknown) {
  const row = asRecord(input)
  const time = asRecord(row?.time)
  const created = asFiniteNumber(time?.created) ?? asFiniteNumber(row?.created_at) ?? now()
  const updated = asFiniteNumber(time?.updated) ?? asFiniteNumber(row?.updated_at) ?? created
  const archived = asFiniteNumber(time?.archived) ?? asFiniteNumber(row?.archived_at)
  const lastHumanTurn = asFiniteNumber(time?.lastHumanTurn) ?? asFiniteNumber(row?.last_human_turn_at)
  return { created, updated, archived, lastHumanTurn }
}
