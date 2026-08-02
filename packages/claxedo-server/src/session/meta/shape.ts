import type { SessionAttachment, SessionToolSandbox } from "./types"
import type { Workspace } from "../../workspace/store"

const KINDS = new Set(["review", "page", "planner"])

export function now() {
  return Date.now()
}

export function rec(input: unknown) {
  return input && typeof input === "object" ? input as Record<string, unknown> : undefined
}

export function txt(input: unknown) {
  return typeof input === "string" && input.trim() ? input.trim() : undefined
}

export function host(input: unknown) {
  return input === "central" || input === "workspace" ? input : undefined
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
  return uniq(input.flatMap((item) => {
    const row = rec(item)
    const kind = txt(row?.kind)
    const targetID = txt(row?.targetID) ?? txt(row?.target_id)
    if (!kind || !targetID || !KINDS.has(kind)) return []
    return [{ kind: kind as SessionAttachment["kind"], targetID }]
  }).map((item) => JSON.stringify(item))).map((item) => JSON.parse(item) as SessionAttachment)
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
 * Parse a stored tool-sandbox ref. Accepts a JSON string (as persisted in the
 * `tool_sandbox` column) or an already-parsed object. Returns `undefined` for
 * missing/malformed values so recovery falls back to the virtual env instead of
 * throwing. The stored ref is reproduced verbatim — including its own
 * `workspaceId`, which may differ from the session's workspace.
 */
export function toolSandbox(input: unknown): SessionToolSandbox | undefined {
  const row = typeof input === "string"
    ? (() => {
        const trimmed = input.trim()
        if (!trimmed) return undefined
        try {
          return rec(JSON.parse(trimmed))
        } catch {
          return undefined
        }
      })()
    : rec(input)
  if (!row) return undefined
  const kind = txt(row.kind)
  if (kind === "workspace-runtime") {
    const workspaceId = txt(row.workspaceId) ?? txt(row.workspace_id)
    if (!workspaceId) return undefined
    const directory = txt(row.directory)
    const worktree = txt(row.worktree)
    const baseCommit = txt(row.baseCommit) ?? txt(row.base_commit)
    const leaseEpoch = num(row.leaseEpoch) ?? num(row.lease_epoch)
    return {
      kind: "workspace-runtime",
      workspaceId,
      ...(directory ? { directory } : {}),
      ...(worktree ? { worktree } : {}),
      ...(baseCommit ? { baseCommit } : {}),
      ...(leaseEpoch !== undefined ? { leaseEpoch } : {}),
    }
  }
  if (kind === "virtual") {
    const id = txt(row.id)
    return { kind: "virtual", ...(id ? { id } : {}) }
  }
  return undefined
}

/** Serialize a tool-sandbox ref for the `tool_sandbox` column (JSON, or null). */
export function serializeToolSandbox(input: SessionToolSandbox | null | undefined): string | null {
  if (!input) return null
  if (input.kind === "workspace-runtime") {
    return JSON.stringify({
      kind: "workspace-runtime",
      workspaceId: input.workspaceId,
      ...(input.directory ? { directory: input.directory } : {}),
      ...(input.worktree ? { worktree: input.worktree } : {}),
      ...(input.baseCommit ? { baseCommit: input.baseCommit } : {}),
      ...(input.leaseEpoch !== undefined ? { leaseEpoch: input.leaseEpoch } : {}),
    })
  }
  return JSON.stringify({
    kind: "virtual",
    ...(input.id ? { id: input.id } : {}),
  })
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
  directory?: string | null
  host?: string | null
}) {
  if (input.workspace_id) return `workspace:${input.workspace_id}:session:${input.session_id}`
  if (input.host === "central") return `central:${input.session_id}`
  return `local:${input.directory ?? "global"}:session:${input.session_id}`
}

export function sessionMetaSyncRow(input: unknown, ws?: Workspace) {
  const item = rec(input)
  const session_id = txt(item?.id)
  if (!session_id) return
  const time = stamp(item)
  const workspace_id = ws?.id ?? txt(item?.workspaceID) ?? null
  const hostValue = host(item?.host) ?? "workspace"
  const directory = txt(item?.directory) ?? ws?.directory ?? null
  return {
    session_ref: storedSessionRef({ session_id, workspace_id, directory, host: hostValue }),
    session_id,
    workspace_id,
    project_id: ws?.project_id ?? txt(item?.projectID) ?? null,
    host: hostValue,
    directory,
    tool_sandbox: serializeToolSandbox(toolSandbox(item?.toolSandbox)),
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
