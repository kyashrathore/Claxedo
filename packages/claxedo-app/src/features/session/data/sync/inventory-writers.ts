import { queryClient } from "@/platform/query/query-client"
import type { SessionInventoryRow } from "../query/types"
import { insertSortedSessionItem, removeSessionIdentity } from "@/platform/sync/global-session-identity"
import {
  deriveSessionInventoryValue,
  emptySessionInventory,
  emptySessionInventoryStore,
  sessionInventoryQueryOptions,
  toCanonicalSessionInventoryStore,
  toSessionInventoryStore,
  workspaceMetaFromGroup,
  type SessionInventoryStoredValue,
  type SessionInventoryWorkspaceGroup,
  type SessionInventoryValue,
} from "./queries"

type SessionInventoryIdentity = {
  id: string
  directory?: string
  workspaceId?: string
  workspaceName?: string
  projectID?: string
  tags?: string[]
  time?: number | { created?: number; updated?: number }
}

type SessionInventoryLifecycleSession =
  Pick<SessionInventoryRow, "id" | "directory" | "projectID" | "parentID"> &
  Partial<Pick<SessionInventoryRow, "title" | "tags">> & {
    workspaceID?: string
    metadata?: Record<string, unknown>
    time: SessionInventoryRow["time"] & { archived?: number }
  }

type SessionInventoryLifecycleType = "created" | "updated" | "deleted"

const GLOBAL_TAG = "global"
const GLOBAL_SHOW_TAG = "global:default"

export function readSessionInventoryQueryData<TSession extends SessionInventoryIdentity = SessionInventoryRow>(input: {
  baseUrl?: string
}) {
  const value = queryClient.getQueryData<SessionInventoryStoredValue<TSession>>(sessionInventoryQueryOptions<TSession>(input).queryKey)
  return value ? deriveSessionInventoryValue(value) : emptySessionInventory<TSession>()
}

export function setSessionInventoryQueryData<TSession extends SessionInventoryIdentity = SessionInventoryRow>(input: {
  baseUrl?: string
  value: SessionInventoryStoredValue<TSession> | SessionInventoryValue<TSession>
}) {
  queryClient.setQueryData(
    sessionInventoryQueryOptions<TSession>({ baseUrl: input.baseUrl }).queryKey,
    toSessionInventoryStore(input.value),
  )
}

export function updateSessionInventoryQueryData<TSession extends SessionInventoryIdentity = SessionInventoryRow>(input: {
  baseUrl?: string
  mutate: (draft: SessionInventoryValue<TSession>) => void
}) {
  queryClient.setQueryData<SessionInventoryStoredValue<TSession>>(
    sessionInventoryQueryOptions<TSession>({ baseUrl: input.baseUrl }).queryKey,
    (current) => {
      const draft = cloneSessionInventory(current ? deriveSessionInventoryValue(current) : emptySessionInventory<TSession>())
      input.mutate(draft)
      return toCanonicalSessionInventoryStore(draft)
    },
  )
}

export function upsertSessionInventoryRow(draft: SessionInventoryValue<SessionInventoryRow>, item: SessionInventoryRow) {
  draft.sessions = insertSortedSessionItem(removeSessionIdentity(draft.sessions, item), item)
}

export function replaceSessionInventoryWorkspaceGroups(
  draft: SessionInventoryValue<SessionInventoryRow>,
  input: {
    groups: Record<string, SessionInventoryWorkspaceGroup<SessionInventoryRow>>
    workspaceState: Record<string, { hasMore: boolean; loading: boolean; cursor?: number }>
    workspaceOrder: string[]
  },
) {
  draft.sessions = Object.values(input.groups).flatMap((group) => group.sessions)
  draft.workspaceMeta = Object.fromEntries(
    Object.entries(input.groups).map(([key, group]) => [key, workspaceMetaFromGroup(key, group)]),
  )
  draft.workspaceState = input.workspaceState
  draft.workspaceOrder = input.workspaceOrder
}

export function mergeSessionInventoryWorkspaceGroups(
  draft: SessionInventoryValue<SessionInventoryRow>,
  input: {
    groups: Record<string, SessionInventoryWorkspaceGroup<SessionInventoryRow>>
    workspaceState: Record<string, { hasMore: boolean; loading: boolean; cursor?: number }>
  },
) {
  for (const [key, group] of Object.entries(input.groups)) {
    for (const item of group.sessions) upsertSessionInventoryRow(draft, item)
    const previous = draft.byWorkspace[key]
    setWorkspaceMeta(draft, key, {
      ...group,
      total: Math.max(previous?.total ?? 0, group.total, workspaceRows(draft, key, group.directory).length),
    })
    draft.workspaceState[key] = input.workspaceState[key] ?? { hasMore: false, loading: false, cursor: undefined }
    if (!draft.workspaceOrder.includes(key)) draft.workspaceOrder.push(key)
  }
}

export function mergeSessionInventoryProjectPage(
  draft: SessionInventoryValue<SessionInventoryRow>,
  input: {
    projectID: string
    workspaceKey: string
    directory: SessionInventoryRow["directory"]
    rows: SessionInventoryRow[]
    cursor: string | number | null
  },
) {
  for (const item of input.rows.filter((row) => row.directory === input.directory)) {
    upsertSessionInventoryRow(draft, item)
  }
  const existing = draft.byWorkspace[input.workspaceKey]
  const rows = workspaceRows(draft, input.workspaceKey, input.directory)
  const nextCursor = input.cursor ? Number(input.cursor) : undefined
  setWorkspaceMeta(draft, input.workspaceKey, {
    key: input.workspaceKey,
    directory: existing?.directory ?? input.directory,
    workspaceId: existing?.workspaceId,
    workspaceName: existing?.workspaceName,
    projectID: existing?.projectID ?? input.projectID,
    sessions: rows,
    hasMore: !!input.cursor,
    total: Math.max(existing?.total ?? 0, rows.length),
    nextCursor,
  })
  draft.workspaceState[input.workspaceKey] = {
    hasMore: !!input.cursor,
    loading: false,
    cursor: nextCursor,
  }
  if (!draft.projectState[input.projectID]) {
    draft.projectState[input.projectID] = { hasMore: false, loading: false, cursor: undefined }
  }
  if (!draft.workspaceOrder.includes(input.workspaceKey)) draft.workspaceOrder.push(input.workspaceKey)
}


export function replaceSessionInventoryWorkspaceRows(
  draft: SessionInventoryValue<SessionInventoryRow>,
  input: {
    workspaceKey: string
    directory: SessionInventoryRow["directory"]
    workspaceName?: string
    projectID: string
    rows: SessionInventoryRow[]
    total: number
  },
) {
  draft.sessions = [
    ...draft.sessions.filter((session) => sessionWorkspaceKey(session) !== input.workspaceKey),
    ...input.rows,
  ]
  const hasMore = input.total > input.rows.length
  setWorkspaceMeta(draft, input.workspaceKey, {
    key: input.workspaceKey,
    directory: input.directory,
    workspaceId: input.workspaceKey,
    workspaceName: input.workspaceName,
    projectID: input.projectID,
    sessions: input.rows,
    hasMore,
    total: input.total,
    nextCursor: input.rows.at(-1)?.time.updated,
  })
  if (!draft.workspaceOrder.includes(input.workspaceKey)) draft.workspaceOrder.push(input.workspaceKey)
  draft.workspaceState[input.workspaceKey] = {
    hasMore,
    loading: false,
    cursor: input.rows.at(-1)?.time.updated,
  }
}

export function createSessionInventorySnapshotValue(input: {
  rows?: SessionInventoryRow[]
  groups?: Record<string, SessionInventoryWorkspaceGroup<SessionInventoryRow>>
  workspaceState?: Record<string, { hasMore: boolean; loading: boolean; cursor?: number }>
  workspaceOrder?: string[]
  projectState?: Record<string, { hasMore: boolean; loading: boolean; cursor?: number }>
  loaded?: boolean
  loading?: boolean
  initialCursor?: number
}): SessionInventoryStoredValue<SessionInventoryRow> {
  const groups = input.groups ?? {}
  return {
    ...emptySessionInventoryStore<SessionInventoryRow>(),
    sessions: [
      ...(input.rows ?? []),
      ...Object.values(groups).flatMap((group) => group.sessions),
    ],
    projectState: input.projectState ?? {},
    workspaceMeta: Object.fromEntries(
      Object.entries(groups).map(([key, group]) => [key, workspaceMetaFromGroup(key, group)]),
    ),
    workspaceState: input.workspaceState ?? {},
    workspaceOrder: input.workspaceOrder ?? Object.keys(groups),
    loading: input.loading ?? false,
    loaded: input.loaded ?? false,
    initialCursor: input.initialCursor,
  }
}

export function applySessionInventoryLifecycle(
  draft: SessionInventoryValue<SessionInventoryRow>,
  info: SessionInventoryLifecycleSession,
  type: SessionInventoryLifecycleType,
) {
  const tags = Array.isArray(info.tags)
    ? info.tags.filter((item): item is string => typeof item === "string")
    : []
  const isTaggedGlobal = tags.includes(GLOBAL_TAG)
  const showTaggedGlobal = tags.includes(GLOBAL_SHOW_TAG)
  // An "updated" event (e.g. a title arriving after the session was already
  // created) may not be able to resolve a projectID itself — the ACP harness
  // auto-title fallback hardcodes `projectID: ""`
  // (packages/agent-sdk-runtime/src/harnesses/acp/title.ts `maybeAutoTitle`).
  // Falling back to the row's ALREADY-KNOWN projectID (instead of dropping
  // the event outright) lets a title update reach a session that's already
  // in the inventory even when this particular event can't resolve one on
  // its own. A "created" event with no resolvable project genuinely has
  // nowhere to live in the grouped inventory and is still dropped.
  const existingProjectID = type === "updated"
    ? draft.sessions.find((session) => session.id === info.id)?.projectID
    : undefined
  const existing = type === "updated"
    ? draft.sessions.find((session) => session.id === info.id)
    : undefined
  if (type === "updated" && !existing) return
  const projectID = info.projectID || existingProjectID
  if (!projectID && !isTaggedGlobal) return
  if (info.parentID) return

  if (type === "deleted" || (isTaggedGlobal && !showTaggedGlobal)) {
    removeSessionInventoryRow(draft, info)
    return
  }

  const metadataSessionRef = typeof info.metadata?.sessionRef === "string"
    ? info.metadata.sessionRef
    : undefined
  const item: SessionInventoryRow = {
    ...existing,
    id: info.id,
    title: info.title || "New Session",
    directory: info.directory,
    ...(metadataSessionRef ? { sessionRef: metadataSessionRef } : {}),
    ...(info.workspaceID ? { workspaceId: info.workspaceID } : {}),
    projectID: isTaggedGlobal ? "global" : projectID!,
    tags: isTaggedGlobal ? tags : tags.length > 0 ? tags : existing?.tags ?? [],
    attachments: existing?.attachments ?? [],
    ...(typeof info.time.archived === "number" ? { archived: true } : {}),
    time: { created: info.time.created, updated: info.time.updated },
  }
  upsertSessionInventoryRow(draft, item)

  if (!isTaggedGlobal && !draft.workspaceState[info.directory]) {
    draft.workspaceState[info.directory] = { hasMore: false, loading: false, cursor: undefined }
  }
}

export function removeSessionInventoryRow<TSession extends SessionInventoryIdentity>(
  draft: SessionInventoryValue<TSession>,
  item: SessionInventoryIdentity,
) {
  const beforeByWorkspace = draft.byWorkspace
  draft.sessions = removeSessionIdentity(draft.sessions, item) as TSession[]
  draft.workspaceMeta = Object.fromEntries(
    Object.entries(draft.workspaceMeta ?? {}).map(([key, meta]) => [
      key,
      beforeByWorkspace[key]
        ? {
          ...meta,
          total: workspaceTotalAfterRemove(beforeByWorkspace[key], item),
          hasMore: beforeByWorkspace[key].hasMore,
          nextCursor: beforeByWorkspace[key].nextCursor,
        }
        : meta,
    ]),
  )
}

export function removeSessionInventorySession<TSession extends SessionInventoryIdentity>(
  inventory: SessionInventoryValue<TSession>,
  target: SessionInventoryIdentity,
): SessionInventoryValue<TSession> {
  const draft = cloneSessionInventory(inventory)
  removeSessionInventoryRow(draft, target)
  return deriveSessionInventoryValue(toCanonicalSessionInventoryStore(draft))
}

export function removeSessionInventoryQueryData<TSession extends SessionInventoryIdentity>(input: {
  baseUrl?: string
  session: SessionInventoryIdentity
}) {
  if (input.baseUrl === undefined) {
    for (const query of queryClient.getQueryCache().findAll({
      predicate: (query) => {
        const key = query.queryKey
        return Array.isArray(key) && key[0] === "shell" && key[2] === "sessionInventory"
      },
    })) {
      const baseUrl = query.queryKey[1]
      if (typeof baseUrl !== "string") continue
      removeSessionInventoryQueryData<TSession>({ baseUrl, session: input.session })
    }
    return
  }
  updateSessionInventoryQueryData<TSession>({
    baseUrl: input.baseUrl,
    mutate: (draft) => {
      removeSessionInventoryRow(draft, input.session)
    },
  })
}

function cloneSessionInventory<TSession>(value: SessionInventoryValue<TSession>): SessionInventoryValue<TSession> {
  return {
    sessions: [...(value.sessions ?? [])],
    sessionOrder: [...(value.sessionOrder ?? [])],
    global: [...value.global],
    globalState: { ...value.globalState },
    byProject: Object.fromEntries(
      Object.entries(value.byProject).map(([key, sessions]) => [key, [...sessions]]),
    ),
    projectState: Object.fromEntries(
      Object.entries(value.projectState).map(([key, state]) => [key, { ...state }]),
    ),
    byWorkspace: Object.fromEntries(
      Object.entries(value.byWorkspace).map(([key, group]) => [
        key,
        {
          ...group,
          sessions: [...group.sessions],
        },
      ]),
    ),
    workspaceMeta: Object.fromEntries(
      Object.entries(value.workspaceMeta ?? {}).map(([key, meta]) => [key, { ...meta }]),
    ),
    workspaceState: Object.fromEntries(
      Object.entries(value.workspaceState).map(([key, state]) => [key, { ...state }]),
    ),
    workspaceOrder: [...value.workspaceOrder],
    loading: value.loading,
    loaded: value.loaded,
    initialCursor: value.initialCursor,
  }
}

function sessionWorkspaceKey(input: SessionInventoryIdentity) {
  return input.workspaceId ?? input.directory
}

function workspaceRows<TSession extends SessionInventoryIdentity>(
  draft: SessionInventoryValue<TSession>,
  key: string,
  directory: SessionInventoryIdentity["directory"],
) {
  return draft.sessions.filter((session) => sessionWorkspaceKey(session) === key || session.directory === directory)
}

function setWorkspaceMeta(
  draft: SessionInventoryValue<SessionInventoryRow>,
  key: string,
  group: SessionInventoryWorkspaceGroup<SessionInventoryRow>,
) {
  draft.workspaceMeta = {
    ...(draft.workspaceMeta ?? {}),
    [key]: workspaceMetaFromGroup(key, group),
  }
}

function workspaceTotalAfterRemove<TSession extends SessionInventoryIdentity>(
  group: SessionInventoryWorkspaceGroup<TSession>,
  item: SessionInventoryIdentity,
) {
  const next = removeSessionIdentity(group.sessions, item)
  return group.hasMore ? Math.max(next.length, group.total - (group.sessions.length - next.length)) : next.length
}
