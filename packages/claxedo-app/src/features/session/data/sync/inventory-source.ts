import type { QueryClient } from "@tanstack/solid-query"
import type { SessionInventoryRow, WorkspaceGroup } from "@/features/session/data/sync/global-sync-types"
import { insertSortedSessionItem } from "@/platform/sync/global-session-identity"
import { normalizeSessionTurnOutcome } from "../session-types"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { createAgentRuntimeClient } from "@/platform/runtime/agent/agent-runtime-client"
import { isFilesystemDirectory, isUserHostedWorkspaceDirectory } from "@/platform/identity/legacy-resolver"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { authFetch as defaultAuthFetch, getClaxedoServerUrl, normalizeUrl } from "@/platform/api/api"
import { accountRun } from "@/platform/account/hosted-control-call"
import { decodeHostedResult } from "@/platform/account/hosted-operations"
import { centralTransportForServer } from "@/platform/runtime/transport"
import { controlSessionListUrl } from "@/platform/runtime/agent/workspace-control-routes"
import { applySessionFilter, type SessionFilter } from "../../../../platform/sync/global-sync/session-filter"
import { paginateSessions } from "../../../../platform/sync/global-sync/session-pagination"
import { mapInventoryToSessions, signedInventoryItems, signedInventoryProjects } from "../query/inventory"

type ProjectDirectory = string
type SignedWorkspaceKind = "cloud" | "user-hosted"
type SignedRuntimeSessionsInput = {
  serverUrl: string
  request: typeof fetch
  workspaceId: string
  directory: ProjectDirectory
  kind: SignedWorkspaceKind
  limit: number
}
type SignedWorkspaceInfo = {
  workspaceId: string
  directory?: ProjectDirectory
  workspaceName?: string
  kind?: string
  status?: string
}
type ResolvedWorkspaceInfo = {
  workspaceId?: string
  directory?: ProjectDirectory
  workspaceName?: string
  kind?: string | null
  status?: string | null
}
type InventorySourceProject = {
  worktree: ProjectDirectory
  sandboxes?: ProjectDirectory[]
  workspaces?: Record<string, { kind?: string; directory?: ProjectDirectory }>
}
export type InventoryGlobalSession = {
  id: string
  sessionRef?: string
  title?: string
  directory: ProjectDirectory
  projectID?: string
  parentID?: string
  time: { created: number; updated: number; archived?: number }
  rootID?: string
  workspaceID?: string
  workspaceId?: string
  tags?: unknown[]
  attachments?: unknown[]
  environment?: unknown
  git?: unknown
  lastTurn?: unknown
}

export async function listSignedWorkspaceRuntimeSessions(input: SignedRuntimeSessionsInput) {
  return (await createAgentRuntimeClient({
    serverUrl: input.serverUrl,
    request: input.request,
    signedControlPlane: true,
    workspaceId: input.workspaceId,
    workspaceKind: input.kind,
  }).listSessions({ directory: input.directory, roots: true, limit: input.limit })).sessions ?? []
}

const CONTROL_SESSIONS_DEDUPE_MS = 3_000
const SIGNED_WORKSPACE_SNAPSHOT_STALE_MS = 10_000

function rec(input: unknown) {
  return input && typeof input === "object" ? input as Record<string, unknown> : undefined
}

function txt(input: unknown) {
  return typeof input === "string" ? input : undefined
}

function inventoryServerUrl(serverUrl: string | undefined) {
  return normalizeUrl(serverUrl) ?? getClaxedoServerUrl()
}

function usesLocalControlTransport(baseUrl: string | undefined) {
  return centralTransportForServer(baseUrl) === "loopback"
}

function controlWorkspaceListUrl(input: { serverUrl?: string; access?: SignedWorkspaceKind }) {
  const url = new URL("/api/workspace", inventoryServerUrl(input.serverUrl))
  if (input.access) url.searchParams.set("access", input.access)
  return url
}

function experimentalSessionUrl(input: {
  serverUrl?: string
  roots?: boolean
  archived?: "active" | "archived" | "all"
  limit?: number
  directory?: string
  cursor?: number
  groupBy?: "workspace"
  perGroup?: number
}) {
  const url = new URL("/experimental/session", inventoryServerUrl(input.serverUrl))
  if (input.roots) url.searchParams.set("roots", "true")
  if (input.archived && input.archived !== "active") url.searchParams.set("archived", input.archived)
  if (input.limit !== undefined) url.searchParams.set("limit", String(input.limit))
  if (input.directory) url.searchParams.set("directory", input.directory)
  if (input.cursor !== undefined) url.searchParams.set("cursor", String(input.cursor))
  if (input.groupBy) url.searchParams.set("groupBy", input.groupBy)
  if (input.perGroup !== undefined) url.searchParams.set("perGroup", String(input.perGroup))
  return url
}

export function workspaceGroupKey(group: Pick<WorkspaceGroup, "key" | "workspaceId" | "directory">) {
  return group.workspaceId ?? (group.key !== "/workspace" ? group.key : undefined) ?? group.directory
}

export function workspaceGroupedRequestKey(key: string) {
  return ["shell", "global-sync", "workspace-groups", key, "request"] as const
}

export function mergeWorkspaceGroups(localGroups: WorkspaceGroup[], signedGroups: WorkspaceGroup[]) {
  if (signedGroups.length === 0) return localGroups
  const byDirectory = new Map<string, WorkspaceGroup>()
  for (const group of localGroups) {
    byDirectory.set(group.directory, {
      ...group,
      sessions: [...group.sessions],
    })
  }
  for (const group of signedGroups) {
    const existing = byDirectory.get(group.directory)
    if (!existing) {
      byDirectory.set(group.directory, {
        ...group,
        sessions: [...group.sessions],
      })
      continue
    }
    for (const item of group.sessions) {
      existing.sessions = insertSortedSessionItem(existing.sessions, item)
    }
    existing.total = Math.max(existing.total, group.total, existing.sessions.length)
    existing.hasMore = existing.hasMore || group.hasMore
    existing.nextCursor = existing.nextCursor ?? group.nextCursor
  }
  return [...byDirectory.values()]
}

/**
 * Workspace runtime statuses that mean "the backing sandbox cannot answer a
 * session list right now". Reported by `GET /api/workspace` from the supervisor
 * lease (`SandboxLeaseStatus`) plus the workspace row's own status
 * (claxedo-server/src/workspace/routes/index.ts:88).
 */
const UNREACHABLE_WORKSPACE_STATUS = [
  "stopped",
  "destroyed",
  "unavailable",
  "failed",
  "offline",
  "deleted",
] as const

export function signedWorkspaceStatus(input: unknown) {
  const row = rec(input)
  return txt(row?.status) ?? txt(row?.runtime_status) ?? txt(row?.runtimeStatus)
}

/**
 * Is this workspace's runtime worth asking for a session list?
 *
 * Sessions sync back into the control plane (Convex `session_history`), so the
 * control-plane list stands on its own when the sandbox is gone. Probing a dead
 * runtime cannot add rows — it can only stall the sidebar behind a relay
 * connect that will never succeed — so an unreachable status makes the
 * control-plane answer authoritative, empty or not. An unknown/absent status is
 * treated as reachable: that is the pre-existing behavior for a healthy
 * workspace and we must not stop falling back for those.
 */
export function workspaceRuntimeReachable(status: string | null | undefined) {
  if (!status) return true
  const normalized = status.trim().toLowerCase()
  return !UNREACHABLE_WORKSPACE_STATUS.some((value) => value === normalized)
}

export function signedWorkspaceHosting(input: unknown) {
  const row = rec(input)
  const access = txt(row?.access)
  if (access === "cloud" || access === "user-hosted") return access
  const backing = txt(row?.backing)
  if (backing === "cloud" || backing === "user-hosted") return backing
  return undefined
}

export function controlPlaneSessionToItem(input: {
  session: unknown
  workspace: unknown
  directory: ProjectDirectory
  workspaceId: string
}): SessionInventoryRow | undefined {
  const row = rec(input.session)
  const workspace = rec(input.workspace)
  const id = txt(row?.session_id) ?? txt(row?.sessionID) ?? txt(row?.id)
  if (!id) return
  const created = typeof row?.created_at === "number"
    ? row.created_at
    : typeof row?.createdAt === "number"
      ? row.createdAt
      : 0
  const updated = typeof row?.updated_at === "number"
    ? row.updated_at
    : typeof row?.updatedAt === "number"
      ? row.updatedAt
      : created
  const lastTurn = normalizeSessionTurnOutcome(row?.lastTurn)
  return {
    id,
    title: txt(row?.title) ?? id,
    directory: input.directory,
    workspaceId: input.workspaceId,
    workspaceName: txt(workspace?.workspace_name) ?? txt(workspace?.workspaceName) ?? txt(workspace?.display_name) ?? txt(workspace?.displayName),
    projectID: txt(workspace?.project_id) ?? txt(workspace?.projectID) ?? id,
    tags: [],
    attachments: [],
    environment: {
      kind: signedWorkspaceHosting(workspace),
      driver: txt(workspace?.backing) ?? txt(workspace?.access),
    },
    ...(lastTurn ? { lastTurn } : {}),
    time: { created, updated },
  }
}

export function inventorySessionAttachments(input: unknown) {
  if (!Array.isArray(input)) return []
  return input.flatMap((item) => {
    const row = rec(item)
    const kind = txt(row?.kind)
    const targetID = txt(row?.targetID) ?? txt(row?.target_id)
    if (!kind || !targetID) return []
    return [{ kind, targetID }]
  })
}

export function inventorySessionEnvironment(input: unknown) {
  const row = rec(input)
  if (!row) return
  const kind = txt(row.kind)
  const driver = txt(row.driver) ?? txt(row.provider)
  if (!kind && !driver) return
  return {
    ...(kind ? { kind } : {}),
    ...(driver ? { driver } : {}),
  }
}

export function inventorySessionGit(input: unknown) {
  const row = rec(input)
  if (!row) return
  const repo = txt(row.repo)
  const branch = txt(row.branch)
  const remote = txt(row.remote)
  if (!repo && !branch && !remote) return
  return {
    ...(repo ? { repo } : {}),
    ...(branch ? { branch } : {}),
    ...(remote ? { remote } : {}),
  }
}

export function toSessionInventoryRow(session: InventoryGlobalSession, input: { projectID?: string } = {}): SessionInventoryRow {
  const projectID = session.projectID || input.projectID || session.directory
  const environment = inventorySessionEnvironment(session.environment)
  const git = inventorySessionGit(session.git)
  const lastTurn = normalizeSessionTurnOutcome(session.lastTurn)
  return {
    id: session.id,
    ...(session.sessionRef ? { sessionRef: session.sessionRef } : {}),
    title: session.title || "New Session",
    directory: session.directory,
    ...(session.workspaceID || session.workspaceId ? { workspaceId: session.workspaceID ?? session.workspaceId } : {}),
    projectID,
    ...(session.parentID ? { parentID: session.parentID } : {}),
    ...(session.rootID ? { rootID: session.rootID } : {}),
    tags: Array.isArray(session.tags) ? session.tags.filter((item): item is string => typeof item === "string") : [],
    attachments: inventorySessionAttachments(session.attachments),
    ...(environment ? { environment } : {}),
    ...(git ? { git } : {}),
    ...(typeof session.time.archived === "number" ? { archived: true } : {}),
    ...(lastTurn ? { lastTurn } : {}),
    time: { created: session.time.created, updated: session.time.updated },
  }
}

export function controlMetaToGlobalSession(input: unknown): InventoryGlobalSession {
  const row = rec(input)
  const lastTurn = normalizeSessionTurnOutcome(row?.lastTurn)
  const created = typeof row?.createdAt === "number" ? row.createdAt : 0
  const workspaceID = txt(row?.workspaceID) ?? txt(row?.workspaceId)
  return {
    id: txt(row?.sessionID) ?? txt(row?.id) ?? "",
    ...(txt(row?.sessionRef) ?? txt(row?.session_ref)
      ? { sessionRef: (txt(row?.sessionRef) ?? txt(row?.session_ref))! }
      : {}),
    title: txt(row?.title) ?? "New Session",
    directory: txt(row?.directory) ?? "",
    ...(workspaceID ? { workspaceID } : {}),
    ...(txt(row?.projectID) ? { projectID: txt(row?.projectID) } : {}),
    ...(txt(row?.parentID) ? { parentID: txt(row?.parentID) } : {}),
    ...(txt(row?.rootID) ? { rootID: txt(row?.rootID) } : {}),
    tags: Array.isArray(row?.tags) ? row.tags : [],
    attachments: Array.isArray(row?.attachments) ? row.attachments : [],
    ...(lastTurn ? { lastTurn } : {}),
    time: {
      created,
      updated: typeof row?.updatedAt === "number" ? row.updatedAt : created,
      ...(typeof row?.archived === "number" ? { archived: row.archived } : {}),
    },
  }
}

export function createSignedInventorySource(input: {
  queryClient: Pick<QueryClient, "fetchQuery">
  baseUrl: () => string
  snapshotBaseUrl?: () => string
  owner: () => string
  authFetch: typeof fetch
  signedWorkspaceInfo: (key: string) => SignedWorkspaceInfo | undefined
  resolveWorkspace: (input: { directory: ProjectDirectory }) => Promise<ResolvedWorkspaceInfo | undefined>
  /**
   * Live runtime status for a workspace, used to decide whether probing the
   * runtime for sessions can possibly help. Called ONLY when the control plane
   * returned no sessions. Omitted (or resolving undefined) means "unknown",
   * which is treated as reachable so healthy workspaces keep their fallback.
   */
  workspaceStatus?: (input: {
    workspaceId: string
    directory: ProjectDirectory
  }) => Promise<string | null | undefined>
  runtimeSessions: (input: {
    workspaceId: string
    directory: ProjectDirectory
    kind?: SignedWorkspaceKind
  }) => Promise<unknown[]>
}) {
  async function fetchSignedRuntimeSessions(sessionInput: {
    workspaceId: string
    directory: ProjectDirectory
    kind?: SignedWorkspaceKind
  }) {
    return await input.queryClient.fetchQuery({
      queryKey: [
        "shell",
        "signed-runtime-sessions",
        input.baseUrl(),
        sessionInput.workspaceId,
        sessionInput.kind ?? "",
      ] as const,
      queryFn: async () => await input.runtimeSessions(sessionInput).catch(() => []),
      staleTime: CONTROL_SESSIONS_DEDUPE_MS,
    })
  }

  async function fetchSignedWorkspaceSessions(sessionInput: {
    workspaceId: string
    directory: ProjectDirectory
    kind?: SignedWorkspaceKind
    /** Known runtime status, when the caller already has it. */
    status?: string | null
  }) {
    const { status: knownStatus, ...runtimeInput } = sessionInput
    const control = await fetchControlPlaneSessions(sessionInput.workspaceId)
    // User-hosted workspaces register session visibility in the authority.
    // The runtime list is complete but not filtered by participant — using it
    // after an empty control-plane answer would show private sessions to Bob.
    if (sessionInput.kind === "user-hosted") return control
    if (control.length > 0) return control
    // Empty control-plane result: only a REACHABLE runtime can hold sessions the
    // control plane has not seen yet. On a dead/stopped sandbox the control
    // plane is authoritative and its empty answer is the truth — falling
    // through would dead-end on a runtime that cannot respond, leaving the
    // sidebar spinning on a workspace whose sessions Convex already has.
    const status = knownStatus ?? await input.workspaceStatus?.({
      workspaceId: sessionInput.workspaceId,
      directory: sessionInput.directory,
    }).catch(() => undefined)
    if (!workspaceRuntimeReachable(status)) return control
    return await fetchSignedRuntimeSessions(runtimeInput)
  }

  async function fetchControlPlaneSessions(workspaceId: string) {
    return await input.queryClient.fetchQuery({
      queryKey: ["shell", "control-plane-sessions", input.baseUrl(), workspaceId] as const,
      queryFn: async () => {
        const run = accountRun()
        if (run) {
          try {
            const body = decodeHostedResult<{ sessions: unknown[] }>(
              "session.list",
              await run("session.list", { workspaceId }),
            )
            return Array.isArray(body.sessions) ? body.sessions : []
          } catch {
            return [] as unknown[]
          }
        }
        const res = await input.authFetch(controlSessionListUrl({
          baseUrl: inventoryServerUrl(input.baseUrl()),
          workspaceId,
        }), { headers: { Accept: "application/json" } })
        if (!res.ok) return [] as unknown[]
        const body = await res.json().catch(() => ({ sessions: [] }))
        return Array.isArray(body?.sessions) ? body.sessions as unknown[] : []
      },
      staleTime: CONTROL_SESSIONS_DEDUPE_MS,
    })
  }

  async function fetchSignedDirectorySessions(directory: ProjectDirectory) {
    const known = input.signedWorkspaceInfo(directory)
    const workspace = known
      ? {
          kind: known.kind,
          workspaceId: known.workspaceId,
          directory: known.directory,
          workspaceName: known.workspaceName,
          status: known.status,
        }
      : await input.resolveWorkspace({ directory })
    if (!workspace?.workspaceId) return []
    const workspaceId = workspace.workspaceId
    const sessions = await fetchSignedWorkspaceSessions({
      workspaceId,
      directory: workspace.directory ?? directory,
      kind: workspace.kind === "cloud" || workspace.kind === "user-hosted" ? workspace.kind : undefined,
      ...(workspace.status === undefined || workspace.status === null ? {} : { status: workspace.status }),
    })
    return sessions.flatMap((session) => {
      const item = controlPlaneSessionToItem({
        session,
        workspace,
        directory: workspace.directory ?? directory,
        workspaceId,
      })
      return item ? [item] : []
    })
  }

  async function fetchControlPlaneWorkspaces(access: SignedWorkspaceKind) {
    const run = accountRun()
    if (run) {
      const operation = access === "cloud" ? "workspace.list.cloud" : "workspace.list.userHosted"
      try {
        const body = decodeHostedResult<{ workspaces: unknown[] }>(
          operation,
          await run(operation, {}),
        )
        return Array.isArray(body.workspaces) ? body.workspaces : []
      } catch {
        return []
      }
    }
    const res = await input.authFetch(controlWorkspaceListUrl({
      serverUrl: input.baseUrl(),
      access,
    }), { headers: { Accept: "application/json" } })
    if (!res.ok) return []
    const body = await res.json().catch(() => ({ workspaces: [] }))
    return Array.isArray(body?.workspaces) ? body.workspaces as unknown[] : []
  }

  async function fetchSignedWorkspaceSnapshot() {
    return await input.queryClient.fetchQuery({
      queryKey: [
        "shell",
        "global-sync",
        "signed-workspace-snapshot",
        ((input.snapshotBaseUrl?.() ?? input.baseUrl()) ?? "default").replace(/\/+$/, ""),
        input.owner(),
      ] as const,
      queryFn: fetchSignedWorkspaceSnapshotUncached,
      staleTime: SIGNED_WORKSPACE_SNAPSHOT_STALE_MS,
    })
  }

  async function fetchSignedWorkspaceSnapshotUncached() {
    const workspaces = [
      ...await fetchControlPlaneWorkspaces("cloud"),
      ...await fetchControlPlaneWorkspaces("user-hosted"),
    ]
    const sessionsByWorkspace = Object.fromEntries(await Promise.all(workspaces.flatMap((workspace) => {
      const row = rec(workspace)
      const workspaceId = txt(row?.workspace_id) ?? txt(row?.workspaceId)
      if (!workspaceId) return []
      const directory = txt(row?.remote_directory) ??
        txt(row?.remoteDirectory) ??
        txt(row?.directory) ??
        `workspace:${workspaceId}`
      return [fetchSignedWorkspaceSessions({
        workspaceId,
        directory,
        kind: signedWorkspaceHosting(workspace),
        // `GET /api/workspace` serves raw Convex workspace rows, which have no
        // status column (convex/schema.ts:203-224); when absent the
        // `workspaceStatus` port resolves the live supervisor status lazily.
        ...(signedWorkspaceStatus(workspace) ? { status: signedWorkspaceStatus(workspace) } : {}),
      }).then((sessions) => [workspaceId, sessions] as const)]
    })))
    const items = signedInventoryItems({ workspaces, sessionsByWorkspace })
    const byDirectory: Record<string, WorkspaceGroup> = {}
    for (const item of items) {
      const key = item.workspaceId ?? item.directory
      const group = byDirectory[key] ?? {
        key,
        directory: item.directory,
        workspaceId: item.workspaceId,
        workspaceName: item.workspaceName,
        projectID: item.projectID,
        sessions: [],
        hasMore: false,
        total: 0,
        nextCursor: undefined,
      }
      group.sessions.push(item)
      group.total = group.sessions.length
      byDirectory[key] = group
    }
    return {
      projects: signedInventoryProjects({ workspaces }),
      groups: Object.values(byDirectory).map((group) => ({
        ...group,
        sessions: group.sessions.sort((a, b) => (b.time.updated ?? 0) - (a.time.updated ?? 0)),
      })),
    }
  }

  return {
    fetchControlPlaneSessions,
    fetchControlPlaneWorkspaces,
    fetchSignedDirectorySessions,
    fetchSignedRuntimeSessions,
    fetchSignedWorkspaceGroups: async () => (await fetchSignedWorkspaceSnapshot()).groups,
    fetchSignedWorkspaceSessions,
    fetchSignedWorkspaceSnapshot,
  }
}

type InventoryPageSourceInput = {
  baseUrl: () => string
  pageSize: number
  platformFetch: () => typeof fetch | undefined
  authFetch?: typeof fetch
  /**
   * Dedupes the local control-session list the same way the signed source
   * dedupes its control-plane lists (`CONTROL_SESSIONS_DEDUPE_MS`): the boot
   * snapshot's flat + grouped fetches and the sidebar's back-to-back workspace
   * reloads all read one list instead of refetching it four times.
   */
  queryClient: QueryClient
  hasSignedAccess: () => boolean
  signedWorkspaceProjects: () => unknown[]
  signedInventorySource: Pick<
    ReturnType<typeof createSignedInventorySource>,
    "fetchSignedDirectorySessions" | "fetchSignedWorkspaceGroups"
  >
}

export function createInventoryPageSource(input: InventoryPageSourceInput) {
  const authFetch = input.authFetch ?? defaultAuthFetch

  async function fetchLocalControlSessions(directory?: string): Promise<InventoryGlobalSession[]> {
    const serverUrl = inventoryServerUrl(getClaxedoServerUrl())
    return await input.queryClient.fetchQuery({
      queryKey: ["shell", "local-control-sessions", serverUrl, directory ?? ""] as const,
      queryFn: async () => {
        const url = new URL("/api/claxedo/session", serverUrl)
        if (directory) url.searchParams.set("directory", directory)
        const res = await (input.platformFetch() ?? globalThis.fetch)(url, { headers: { Accept: "application/json" } })
        if (!res.ok) return []
        const body = rec(await res.json().catch(() => ({ sessions: [] })))
        const rows = Array.isArray(body?.sessions) ? body.sessions : []
        return rows.map(controlMetaToGlobalSession).filter((session) => !!session.id)
      },
      staleTime: CONTROL_SESSIONS_DEDUPE_MS,
    })
  }

  async function fetchLocalWorkspaceRuntimeSessions(directory: string): Promise<InventoryGlobalSession[]> {
    const runtimeSessionClient = createAgentRuntimeClient({
      serverUrl: input.baseUrl(),
      request: globalThis.fetch,
    })
    const body = await runtimeSessionClient.listSessions({
      directory,
      roots: true,
      limit: input.pageSize,
    }).catch(() => ({ sessions: [] }))
    return (body.sessions ?? [])
      .filter((session) => !!session?.id)
      .map((session) => ({ ...session, directory }))
  }

  async function fetchGlobalList(opts: { directory?: string; limit: number; cursor?: number }) {
    if (opts.directory && shouldUseSignedControlPlaneInventory({
      hasSignedAccess: input.hasSignedAccess(),
      baseUrl: input.baseUrl(),
      directory: opts.directory,
    })) {
      return {
        data: mapInventoryToSessions(await input.signedInventorySource.fetchSignedDirectorySessions(opts.directory)),
        cursor: null,
      }
    }
    if (usesLocalControlTransport(input.baseUrl())) {
      const page = paginateSessions(
        opts.directory && sessionWorkspaceRuntimeRef({ directory: opts.directory })
          ? await fetchLocalWorkspaceRuntimeSessions(opts.directory)
          : await fetchLocalControlSessions(opts.directory),
        { limit: opts.limit, cursor: opts.cursor },
      )
      return { data: page.sessions, cursor: page.nextCursor ?? null }
    }
    const url = experimentalSessionUrl({
      serverUrl: input.baseUrl(),
      roots: true,
      archived: "all",
      limit: opts.limit,
      directory: opts.directory,
      cursor: opts.cursor,
    })
    const res = await (input.platformFetch() ?? globalThis.fetch)(url, {
      headers: { Accept: "application/json" },
    })
    if (!res.ok) return { data: [] as InventoryGlobalSession[], cursor: null }
    const body = await res.json().catch(() => [])
    return {
      data: Array.isArray(body) ? body as InventoryGlobalSession[] : [],
      cursor: res.headers.get("x-next-cursor"),
    }
  }

  async function fetchWorkspaceGrouped(opts: { perGroup?: number; filter?: SessionFilter } = {}): Promise<WorkspaceGroup[]> {
    if (input.signedWorkspaceProjects().length > 0) return await input.signedInventorySource.fetchSignedWorkspaceGroups()
    if (usesLocalControlTransport(input.baseUrl())) {
      const sessions = await fetchLocalControlSessions()
      const byDir = new Map<string, InventoryGlobalSession[]>()
      for (const session of sessions) {
        const key = session.workspaceID || session.workspaceId || session.directory || session.projectID || session.id
        byDir.set(key, [...(byDir.get(key) ?? []), session])
      }
      return [...byDir.entries()].map(([key, group]) => {
        const directory = group.find((session) =>
          !session.sessionRef?.startsWith("central:") && !!session.directory
        )?.directory ?? key
        return {
          key,
          directory,
          ...(group[0]?.workspaceID || group[0]?.workspaceId
            ? { workspaceId: group[0]?.workspaceID ?? group[0]?.workspaceId }
            : {}),
          projectID: group[0]?.projectID ?? key,
          ...(() => {
            const page = paginateSessions(group, { limit: opts.perGroup ?? input.pageSize })
            return {
              sessions: page.sessions.map((session) => toSessionInventoryRow(session)),
              hasMore: page.hasMore,
              total: page.total,
              nextCursor: page.nextCursor,
            }
          })(),
        }
      })
    }
    const url = experimentalSessionUrl({
      serverUrl: getClaxedoServerUrl(),
      roots: true,
      groupBy: "workspace",
      perGroup: opts.perGroup ?? input.pageSize,
    })
    applySessionFilter(url, opts.filter)
    const key = url.toString()
    const requestKey = workspaceGroupedRequestKey(key)
    return await queryClient.fetchQuery({
      queryKey: requestKey,
      queryFn: async () => {
        const res = await authFetch(url, {
          headers: { Accept: "application/json" },
        })
        if (!res.ok) return []
        const body = rec(await res.json().catch(() => ({ groups: [] })))
        return Array.isArray(body?.groups) ? body.groups as WorkspaceGroup[] : []
      },
    })
      .catch(() => [])
      .finally(() => queryClient.removeQueries({ queryKey: requestKey }))
  }

  async function fetchWorkspacePage(directory: string, opts: { limit: number; filter?: SessionFilter; cursor?: number }) {
    if (shouldUseSignedControlPlaneInventory({
      hasSignedAccess: input.hasSignedAccess(),
      baseUrl: input.baseUrl(),
      directory,
    })) {
      return {
        data: mapInventoryToSessions(await input.signedInventorySource.fetchSignedDirectorySessions(directory)),
        cursor: null,
      }
    }
    if (usesLocalControlTransport(input.baseUrl())) {
      const page = paginateSessions(
        sessionWorkspaceRuntimeRef({ directory })
          ? await fetchLocalWorkspaceRuntimeSessions(directory)
          : await fetchLocalControlSessions(directory),
        { limit: opts.limit, cursor: opts.cursor },
      )
      return { data: page.sessions, cursor: page.nextCursor ?? null }
    }
    const url = experimentalSessionUrl({
      serverUrl: getClaxedoServerUrl(),
      roots: true,
      directory,
      limit: opts.limit,
      cursor: opts.cursor,
    })
    applySessionFilter(url, opts.filter)
    const res = await authFetch(url, {
      headers: { Accept: "application/json" },
    })
    if (!res.ok) return { data: [] as InventoryGlobalSession[], cursor: null }
    const body = await res.json().catch(() => [])
    return {
      data: Array.isArray(body) ? body as InventoryGlobalSession[] : [],
      cursor: res.headers.get("x-next-cursor"),
    }
  }

  return {
    fetchGlobalList,
    fetchLocalControlSessions,
    fetchLocalWorkspaceRuntimeSessions,
    fetchWorkspaceGrouped,
    fetchWorkspacePage,
  }
}

function sameDirectory(left: string | undefined, right: string | undefined) {
  return !!left && !!right && left.replace(/\/+$/, "") === right.replace(/\/+$/, "")
}

function cachedProjects(baseUrl: string | undefined) {
  return queryClient.getQueryData<InventorySourceProject[]>(queryKeys.controlPlane.projects(baseUrl)) ?? []
}

function cachedSignedWorkspaceDirectory(baseUrl: string | undefined, key: string | undefined) {
  if (!key) return false
  return cachedProjects(baseUrl).some((project) =>
    Object.entries(project.workspaces ?? {}).some(([workspaceKey, workspace]) =>
      (workspace.kind === "cloud" || workspace.kind === "user-hosted")
      && (sameDirectory(workspaceKey, key) || sameDirectory(workspace.directory, key))
    )
  )
}

export function shouldUseSignedControlPlaneInventory(input: {
  hasSignedAccess: boolean
  baseUrl: string
  directory?: ProjectDirectory
  workspaceId?: string
}) {
  if (!input.hasSignedAccess) return false
  if (input.workspaceId) return true
  if (cachedSignedWorkspaceDirectory(input.baseUrl, input.directory)) return true
  if (input.directory && !isFilesystemDirectory(input.directory)) return true
  if (isUserHostedWorkspaceDirectory(input.directory)) return true
  if (!usesLocalControlTransport(input.baseUrl)) return true
  return false
}

export function shouldUseSignedSessionInventory(input: {
  hasSignedAccess: boolean
  signedRoute: boolean
  baseUrl: string
}) {
  if (input.signedRoute) return true
  return shouldUseSignedControlPlaneInventory({
    hasSignedAccess: input.hasSignedAccess || input.signedRoute,
    baseUrl: input.baseUrl,
  })
}

export function shouldUseSignedProjectSessionInventory(input: {
  hasSignedAccess: boolean
  baseUrl: string
  project: InventorySourceProject
}) {
  if (Object.values(input.project.workspaces ?? {}).some((workspace) =>
    workspace.kind === "cloud" || workspace.kind === "user-hosted"
  )) return input.hasSignedAccess
  return [
    input.project.worktree,
    ...(input.project.sandboxes ?? []),
    ...Object.keys(input.project.workspaces ?? {}),
  ].some((directory) =>
    shouldUseSignedControlPlaneInventory({
      hasSignedAccess: input.hasSignedAccess,
      baseUrl: input.baseUrl,
      directory,
    }))
}
