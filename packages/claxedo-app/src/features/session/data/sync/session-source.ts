import { queryOptions } from "@tanstack/solid-query"
import { getClaxedoServerUrl, normalizeUrl } from "@/platform/api/api"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { agentRuntimeSessionListUrl } from "@/platform/runtime/agent/agent-runtime-urls"
import { createTransport } from "@/platform/runtime/transport"
import {
  isUserHostedWorkspaceKind,
  USER_HOSTED_WORKSPACE_KIND,
  workspaceKind,
  type WorkspaceKind,
} from "@/platform/runtime/agent/workspace-kind"
import type { SessionNavigationRow } from "../../ui/navigation/session-navigation"
import {
  applyFetchedSessionListPage,
  fetchSessionListPage,
  mergeSessionListItems,
  sessionListQueryKey,
  type SessionListQuery,
  type SessionListResponse,
} from "../query/session-list"

/**
 * Where one workspace's sessions are read from, chosen by the catalog row's
 * `kind` and by nothing else.
 *
 * - `local`: the machine's own daemon, over loopback.
 * - `cloud`: the control plane's registry, which is the authority for the
 *   sessions of a workspace it provisions.
 * - `user-hosted`: the workspace's own runtime, over the relay connection the
 *   app already holds — one hop, role enforced by the relay token. Own and
 *   shared workspaces are the same source; the role only gates affordances.
 *
 * The registry holds only the user-hosted sessions that were created THROUGH
 * it, so asking it for that workspace's list answers a subset the client cannot
 * tell apart from an empty machine. `claxedo-server`'s session-list route now
 * refuses that read (409 `workspace_runtime_session_authority`) rather than
 * answering it.
 *
 * `composed` is not a workspace kind: it is a SECTION whose workspaces do not
 * all answer from one server — a project holding a user-hosted workspace
 * beside a local or cloud one. Its members are the per-workspace sources
 * above, and its page is their pages merged.
 */
export type SessionSource =
  | { kind: "local" | "cloud" }
  | { kind: "user-hosted"; workspaceId: string; projectId?: string }
  | { kind: "composed"; central: CentralSessionSource; userHosted: UserHostedSessionSource[] }

type CentralSessionSource = Extract<SessionSource, { kind: "local" | "cloud" }>
type UserHostedSessionSource = Extract<SessionSource, { kind: "user-hosted" }>

/** The composed page's key for the central member's own cursor. */
const COMPOSED_CENTRAL_MEMBER = "central"

/** Rows the runtime answers with are re-shaped once and paged from memory. */
const USER_HOSTED_SESSION_LIST_STALE_MS = 30_000

/**
 * The directory a session row carries, for every workspace kind.
 *
 * Every later read of that session — messages, config, agents, the transcript —
 * is scoped by this value, so it has to be an address THIS app can resolve, and
 * one answer has to hold whichever producer stamped the row (a fetched list, or
 * a `session.created`/`session.updated` frame applied by `event-ingress`).
 *
 * - `local`: the host IS this machine, so its path is the row's directory.
 * - `cloud` and `user-hosted`: the workspace is addressed by its signed id —
 *   over the registry, or over the relay — while `hostDirectory` is a path on
 *   ANOTHER machine. Carrying it makes every later read scope itself by a
 *   directory this app cannot reach and 404, so the row carries
 *   `workspace:<workspaceId>` instead.
 *
 * The signed `ws_*` id is what separates the two: a row that has one is
 * addressed by workspace, a row without one names a path on this machine.
 */
export function sessionRowDirectory(input: {
  workspaceId: string | undefined
  /** The path the producing runtime reported — its OWN machine's, always. */
  hostDirectory: string
}) {
  return input.workspaceId ? `workspace:${input.workspaceId}` : input.hostDirectory
}

/**
 * The app's own central server's list: the daemon's on a local surface, the
 * control plane's registry on the hosted web. Global Chat's sessions belong to
 * no workspace and live there, by the same rule that puts a local workspace's
 * sessions on the daemon and a cloud workspace's in the registry.
 */
export function centralSessionSource(input: { local: boolean }): CentralSessionSource {
  return { kind: input.local ? "local" : "cloud" }
}

export function sessionSourceForWorkspace(input: {
  kind: WorkspaceKind | undefined
  workspaceId: string
  projectId?: string
}): SessionSource {
  if (!isUserHostedWorkspaceKind(input.kind)) return { kind: input.kind === "cloud" ? "cloud" : "local" }
  return {
    kind: USER_HOSTED_WORKSPACE_KIND,
    workspaceId: input.workspaceId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
  }
}

/**
 * A PROJECT's source: every source its own workspaces are read from.
 *
 * A project section lists the sessions of all its workspaces, and those do not
 * share one server — the central one answers for the local and cloud
 * workspaces, and each user-hosted workspace answers from its own runtime over
 * the relay, by the same `sessionSourceForWorkspace` rule its own section
 * uses. A project with no user-hosted workspace IS the central source: a
 * composition of one member is that member.
 */
export function projectSessionSource(input: {
  local: boolean
  projectId: string
  /** The project's catalog rows, under the refs the catalog keys them by. */
  workspaces: Record<string, { kind?: string; id?: string; workspaceId?: string }> | undefined
}): SessionSource {
  const central = centralSessionSource({ local: input.local })
  const byWorkspaceId = new Map<string, UserHostedSessionSource>()
  for (const [ref, workspace] of Object.entries(input.workspaces ?? {})) {
    const source = sessionSourceForWorkspace({
      kind: workspaceKind(workspace.kind),
      // The signed id a relay-backed workspace is addressed by; the catalog's
      // own key is a directory on the HOST, which this app cannot reach.
      workspaceId: workspace.workspaceId ?? workspace.id ?? ref,
      projectId: input.projectId,
    })
    // One workspace is one source however many refs name it; a second read of
    // the same runtime would only duplicate its rows.
    if (source.kind === USER_HOSTED_WORKSPACE_KIND) byWorkspaceId.set(source.workspaceId, source)
  }
  if (byWorkspaceId.size === 0) return central
  return { kind: "composed", central, userHosted: [...byWorkspaceId.values()] }
}

/**
 * One rail section's list, from its own source.
 *
 * Every source writes the SAME cache entry (`shell.sessionList` for the
 * section's query), so the readers, the pagination and the event appliers in
 * `session-list.ts` stay one implementation whichever server answered — and a
 * composed source folds its members into that one entry rather than opening a
 * second list for the same section.
 */
export function sessionSourceQueryOptions(input: {
  baseUrl?: string
  source: SessionSource
  query: SessionListQuery
  request?: typeof fetch
}) {
  return queryOptions({
    queryKey: sessionListQueryKey(input.baseUrl, input.query),
    queryFn: async () => applyFetchedSessionListPage({
      baseUrl: input.baseUrl,
      query: input.query,
      page: await sessionSourcePage(input),
    }),
  })
}

/** The page one source answers the section's query with. */
async function sessionSourcePage(input: {
  baseUrl?: string
  source: SessionSource
  query: SessionListQuery
  request?: typeof fetch
}): Promise<SessionListResponse> {
  const source = input.source
  if (source.kind === "composed") return composedSessionListPage({ ...input, source })
  if (source.kind === USER_HOSTED_WORKSPACE_KIND) {
    return sessionListPage(
      await userHostedSessionRows({
        baseUrl: input.baseUrl,
        source,
        ...(input.request ? { request: input.request } : {}),
      }),
      input.query,
    )
  }
  return await fetchSessionListPage({
    baseUrl: input.baseUrl,
    query: input.query,
    ...(input.request ? { request: input.request } : {}),
  })
}

/**
 * A composed section's page: every member's page for the same view, merged.
 *
 * Each member pages independently — the central server hands out its own
 * opaque cursor and a runtime's rows are paged from memory — so the composed
 * cursor is the map of the members that still have one, and a later page asks
 * only those. A member that fails fails the section: a project list that
 * silently dropped an unreachable workspace's rows would read as an empty
 * workspace rather than an unreachable one.
 */
async function composedSessionListPage(input: {
  baseUrl?: string
  source: Extract<SessionSource, { kind: "composed" }>
  query: SessionListQuery
  request?: typeof fetch
}): Promise<SessionListResponse> {
  const cursors = composedCursors(input.query.cursor)
  const { cursor: _paged, ...memberQuery } = input.query
  const pageQuery = (cursor: string | undefined) => cursor === undefined ? memberQuery : { ...memberQuery, cursor }
  const members = [
    // The runtime owns its workspace's sessions, so its row wins over a
    // central row for the same session.
    ...input.source.userHosted.map((source) => ({
      key: source.workspaceId,
      page: async (cursor: string | undefined) => sessionListPage(
        await userHostedSessionRows({
          baseUrl: input.baseUrl,
          source,
          ...(input.request ? { request: input.request } : {}),
        }),
        pageQuery(cursor),
      ),
    })),
    {
      key: COMPOSED_CENTRAL_MEMBER,
      page: (cursor: string | undefined) => fetchSessionListPage({
        baseUrl: input.baseUrl,
        query: pageQuery(cursor),
        ...(input.request ? { request: input.request } : {}),
      }),
    },
  ]
  const pages = await Promise.all(members
    .filter((member) => !cursors || member.key in cursors)
    .map(async (member) => ({ key: member.key, page: await member.page(cursors?.[member.key]) })))
  const sort = input.query.sort ?? "updated_desc"
  const nextCursors = Object.fromEntries(pages.flatMap(({ key, page }) => page.nextCursor ? [[key, page.nextCursor]] : []))
  return {
    view: { scope: input.query.scope, groupBy: input.query.groupBy ?? "none", sort, limit: input.query.limit },
    items: sortSessionRows(
      pages.reduce<SessionNavigationRow[]>((merged, { page }) => mergeSessionListItems(merged, page.items ?? []), []),
      sort,
    ),
    totalKnown: pages.reduce((total, { page }) => total + (page.totalKnown ?? page.items?.length ?? 0), 0),
    ...(Object.keys(nextCursors).length ? { nextCursor: JSON.stringify(nextCursors) } : {}),
  }
}

/** The per-member cursors a composed page handed out, or nothing on page one. */
function composedCursors(cursor: string | undefined): Record<string, string> | undefined {
  if (cursor === undefined) return undefined
  const parsed = parseJson(cursor)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  return Object.fromEntries(Object.entries(parsed as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"))
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

/**
 * The workspace runtime's own `GET /session`, over the relay.
 *
 * Cached per WORKSPACE rather than per list query: the rail asks for the same
 * workspace under a workspace-scoped query, under its project's section, and
 * again for each page, and one relay hop answers all of them.
 */
async function userHostedSessionRows(input: {
  baseUrl?: string
  source: Extract<SessionSource, { kind: "user-hosted" }>
  request?: typeof fetch
}) {
  const serverUrl = normalizeUrl(input.baseUrl) ?? getClaxedoServerUrl()
  return await queryClient.fetchQuery({
    queryKey: queryKeys.runtime.workspaceSessions(serverUrl, input.source.workspaceId),
    staleTime: USER_HOSTED_SESSION_LIST_STALE_MS,
    queryFn: async () => {
      const runtime = createTransport({
        // The workspace is served by ANOTHER machine even when this app's own
        // central is a loopback daemon, so the placement names the relay and
        // the read never goes through this machine's workspace bridge.
        placement: {
          hosting: "workspace",
          transport: "workspace-relay",
          workspaceId: input.source.workspaceId,
        },
        serverUrl,
        workspace: { kind: USER_HOSTED_WORKSPACE_KIND, workspaceId: input.source.workspaceId },
        ...(input.request ? { request: input.request, relayRequest: input.request } : {}),
      })
      const list = agentRuntimeSessionListUrl({ serverUrl, roots: true })
      const rows = await runtime.json<unknown>(`${list.pathname}${list.search}`)
      return (Array.isArray(rows) ? rows : []).flatMap((row) => {
        const item = userHostedNavigationRow(row, input.source)
        return item ? [item] : []
      })
    },
  })
}

function userHostedNavigationRow(
  row: unknown,
  source: Extract<SessionSource, { kind: "user-hosted" }>,
): SessionNavigationRow | undefined {
  const item = rec(row)
  const sessionId = txt(item?.id)
  if (!sessionId) return
  const time = rec(item?.time)
  const createdAt = num(time?.created) ?? 0
  const updatedAt = num(time?.updated) ?? createdAt
  const archivedAt = num(time?.archived)
  return {
    type: "session",
    sessionRef: `workspace:${source.workspaceId}:session:${sessionId}`,
    sessionId,
    title: txt(item?.title) ?? "Untitled session",
    // The runtime answers with the HOST's own filesystem path; what the row
    // carries is `sessionRowDirectory`'s to decide.
    directory: sessionRowDirectory({
      workspaceId: source.workspaceId,
      hostDirectory: txt(item?.directory) ?? "",
    }),
    workspaceId: source.workspaceId,
    ...(source.projectId ? { projectId: source.projectId } : {}),
    createdAt,
    updatedAt,
    ...(archivedAt ? { archivedAt } : {}),
    tags: [],
    attachments: [],
  }
}

/**
 * The section's page, cut from the workspace's rows.
 *
 * The runtime answers with the workspace's whole root list and no cursor, so
 * the view's ordering, archive filter and paging are applied here — the same
 * contract `buildSessionListResponse` applies to a registry answer, against the
 * only fields a runtime row carries.
 */
function sessionListPage(rows: SessionNavigationRow[], query: SessionListQuery): SessionListResponse {
  const sort = query.sort ?? "updated_desc"
  const matched = sortSessionRows(rows.filter((row) => rowMatchesView(row, query)), sort)
  const offset = pageOffset(query.cursor)
  const items = matched.slice(offset, offset + query.limit)
  const next = offset + items.length
  return {
    view: { scope: query.scope, groupBy: query.groupBy ?? "none", sort, limit: query.limit },
    items,
    totalKnown: matched.length,
    ...(next < matched.length ? { nextCursor: String(next) } : {}),
  }
}

/**
 * The view's own ordering, applied to rows this app assembled — a runtime's
 * whole list, or several sources' pages merged into one section's page.
 */
function sortSessionRows(
  rows: readonly SessionNavigationRow[],
  sort: NonNullable<SessionListQuery["sort"]>,
): SessionNavigationRow[] {
  return [...rows].sort((a, b) => sort === "created_desc"
    ? b.createdAt - a.createdAt || b.sessionRef.localeCompare(a.sessionRef)
    : b.updatedAt - a.updatedAt || b.sessionRef.localeCompare(a.sessionRef))
}

function pageOffset(cursor: string | undefined) {
  const offset = cursor === undefined ? 0 : Number(cursor)
  return Number.isSafeInteger(offset) && offset > 0 ? offset : 0
}

function rowMatchesView(row: SessionNavigationRow, query: SessionListQuery) {
  if (query.archived === "active" && row.archivedAt) return false
  if (query.archived === "archived" && !row.archivedAt) return false
  // Status, environment and git are derived from tags, attachments and repo
  // metadata the registry stamps on a row it owns; a runtime row carries none,
  // so an active filter of any of them matches nothing here — the same answer
  // the registry's `valuesMatch` gives for a row with no values.
  if (query.status?.length || query.environment?.length || query.git?.length) return false
  if (query.search && !row.title.toLowerCase().includes(query.search.toLowerCase())) return false
  return true
}

function rec(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

function txt(input: unknown) {
  return typeof input === "string" && input.trim() ? input.trim() : undefined
}

function num(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}
