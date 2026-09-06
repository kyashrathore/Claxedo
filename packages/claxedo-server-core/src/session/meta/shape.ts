import { isOneOf, jsonRecord as rec } from "../../platform/runtime/lib/json"
import { SESSION_ATTACHMENT_KINDS, type SessionAttachment } from "./types"
export { jsonRecord as rec } from "../../platform/runtime/lib/json"
import type { Workspace } from "../../workspace/store"



export function now() {
  return Date.now()
}

export function txt(input: unknown) {
  return typeof input === "string" && input.trim() ? input.trim() : undefined
}

export function host(input: unknown) {
  return input === "workspace" ? input : undefined
}

function num(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
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
    const row = rec(item)
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

export function sessionModel(input: unknown): { providerID: string; modelID: string } | undefined {
  const row = rec(input)
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
  const item = rec(input)
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
  }
}

export function parseSessionMeta(input: unknown) {
  const row = rec(input)
  return {
    ...(row && "title" in row ? { title: txt(row.title) ?? null } : {}),
    ...(row && "parentID" in row ? { parentID: txt(row.parentID) ?? null } : {}),
    ...(row && "tags" in row ? { tags: tags(row.tags) ?? [] } : {}),
    ...(row && "attachments" in row ? { attachments: attachments(row.attachments) ?? [] } : {}),
  }
}

function stamp(input: unknown) {
  const row = rec(input)
  const time = rec(row?.time)
  const created = num(time?.created) ?? num(row?.created_at) ?? now()
  const updated = num(time?.updated) ?? num(row?.updated_at) ?? created
  const archived = num(time?.archived) ?? num(row?.archived_at)
  return { created, updated, archived }
}
