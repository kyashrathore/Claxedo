import type { QueryClient } from "@tanstack/solid-query"
import type { SessionInventoryRow, WorkspaceGroup } from "@/features/session/data/sync/global-sync-types"
import { insertSortedSessionItem } from "@/platform/sync/global-session-identity"
import { normalizeSessionTurnOutcome } from "../session-types"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { createAgentRuntimeClient } from "@/platform/runtime/agent/agent-runtime-client"
import { workspaceHostingKind, type SignedWorkspaceKind } from "@/platform/runtime/agent/signed-workspace"
import { isFilesystemDirectory, isUserHostedWorkspaceDirectory } from "@/platform/identity/legacy-resolver"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { authFetch as defaultAuthFetch, getClaxedoServerUrl, normalizeUrl } from "@/platform/api/api"
import { signedAccountRun } from "@/platform/account/hosted-control-call"
import { decodeHostedResult } from "@/platform/account/hosted-operations"
import { centralTransportForServer } from "@/platform/runtime/transport"
import { controlSessionListUrl } from "@/platform/runtime/agent/workspace-control-routes"
import { applySessionFilter, type SessionFilter } from "../../../../platform/sync/global-sync/session-filter"
import { paginateSessions } from "../../../../platform/sync/global-sync/session-pagination"
import { mapInventoryToSessions, signedInventoryItems, signedInventoryProjects } from "../query/inventory"
import {
  inventoryRecord as rec,
  inventorySessionAttachments,
  inventorySessionEnvironment,
  inventorySessionGit,
  inventorySessionId,
  inventoryText as txt,
} from "./session-inventory"
export { inventorySessionAttachments, inventorySessionEnvironment, inventorySessionGit } from "./session-inventory"

type ProjectDirectory = string
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

const CONTROL_SESSIONS_DEDUPE_MS = 3_000

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
      kind: workspaceHostingKind(workspace),
      driver: txt(workspace?.backing) ?? txt(workspace?.access),
    },
    ...(lastTurn ? { lastTurn } : {}),
    time: { created, updated },
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
  owner: () => string
  authFetch: typeof fetch
  signedWorkspaceInfo: (key: string) => SignedWorkspaceInfo | undefined
  resolveWorkspace: (input: { directory: ProjectDirectory }) => Promise<ResolvedWorkspaceInfo | undefined>
}) {
  async function fetchSignedWorkspaceSessions(sessionInput: {
    workspaceId: string
    directory: ProjectDirectory
    kind?: SignedWorkspaceKind
  }) {
    // This is a display read (snapshot rows, directory session lists), so it
    // shares the deduping cache: the same workspace is asked for by both the
    // signed-workspace snapshot and each directory's own bootstrap within the
    // same boot window, and without the shared cache that turns into one
    // request per caller instead of one per workspace. The security boundary
    // is `hasControlPlaneSessionAccess`, not this list — it calls
    // `requestControlPlaneSessions` directly so a revoke is never masked by a
    // stale cache entry.
    return await fetchControlPlaneSessions(sessionInput.workspaceId)
  }

  async function requestControlPlaneSessions(workspaceId: string) {
    const run = await signedAccountRun()
    if (run) {
      const body = decodeHostedResult<{ sessions: unknown[] }>(
        "session.list",
        await run("session.list", { workspaceId }),
      )
      if (!Array.isArray(body.sessions)) throw new Error("session.list returned an invalid sessions payload")
      return body.sessions
    }
    const res = await input.authFetch(controlSessionListUrl({
      baseUrl: inventoryServerUrl(input.baseUrl()),
      workspaceId,
    }), { headers: { Accept: "application/json" } })
    if (!res.ok) throw new Error(`Control-plane session list failed with ${res.status}`)
    const body = await res.json()
    if (!Array.isArray(body?.sessions)) throw new Error("Control-plane session list returned an invalid sessions payload")
    return body.sessions as unknown[]
  }

  async function fetchControlPlaneSessions(workspaceId: string) {
    return await input.queryClient.fetchQuery({
      queryKey: ["shell", "control-plane-sessions", input.baseUrl(), input.owner(), workspaceId] as const,
      queryFn: async () => await requestControlPlaneSessions(workspaceId),
      staleTime: CONTROL_SESSIONS_DEDUPE_MS,
    })
  }

  async function hasControlPlaneSessionAccess(target: { workspaceId: string; sessionId: string }) {
    // Security boundary: never reuse cached or in-flight authority data after revoke.
    const sessions = await requestControlPlaneSessions(target.workspaceId)
    return sessions.some((session) => inventorySessionId(session) === target.sessionId)
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
    const run = await signedAccountRun()
    if (run) {
      const operation = access === "cloud" ? "workspace.list.cloud" : "workspace.list.userHosted"
      const body = decodeHostedResult<{ workspaces: unknown[] }>(
        operation,
        await run(operation, {}),
      )
      if (!Array.isArray(body.workspaces)) throw new Error(`${operation} returned an invalid workspaces payload`)
      return body.workspaces
    }
    const res = await input.authFetch(controlWorkspaceListUrl({
      serverUrl: input.baseUrl(),
      access,
    }), { headers: { Accept: "application/json" } })
    if (!res.ok) throw new Error(`Control-plane ${access} workspace list failed with ${res.status}`)
    const body = await res.json()
    if (!Array.isArray(body?.workspaces)) {
      throw new Error(`Control-plane ${access} workspace list returned an invalid workspaces payload`)
    }
    return body.workspaces as unknown[]
  }

  async function fetchSignedWorkspaceSnapshot() {
    // This snapshot authorizes both visible rows and durable conversation
    // writes. It must be a fresh authority read: reusing a pre-revoke cache can
    // resurrect a revoked row or clear its persistence fence.
    return await fetchSignedWorkspaceSnapshotUncached()
  }

  async function fetchSignedWorkspaceSnapshotUncached() {
    // Cloud and user-hosted are independent access lists on independent
    // routes/operations — nothing here reads one to form the other — so they
    // run concurrently instead of paying two serial round trips.
    const [cloudWorkspaces, userHostedWorkspaces] = await Promise.all([
      fetchControlPlaneWorkspaces("cloud"),
      fetchControlPlaneWorkspaces("user-hosted"),
    ])
    const workspaces = [...cloudWorkspaces, ...userHostedWorkspaces]
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
        kind: workspaceHostingKind(workspace),
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
    fetchSignedWorkspaceGroups: async () => (await fetchSignedWorkspaceSnapshot()).groups,
    fetchSignedWorkspaceSessions,
    fetchSignedWorkspaceSnapshot,
    hasControlPlaneSessionAccess,
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
