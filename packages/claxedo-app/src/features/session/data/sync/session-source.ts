import { queryOptions } from "@tanstack/solid-query"
import { getClaxedoServerUrl, normalizeUrl } from "@/platform/api/api"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { agentRuntimeSessionListUrl } from "@/platform/runtime/agent/agent-runtime-urls"
import { createTransport } from "@/platform/runtime/transport"
import {
  isUserHostedWorkspaceKind,
  USER_HOSTED_WORKSPACE_KIND,
  type WorkspaceKind,
} from "@/platform/runtime/agent/workspace-kind"
import type { SessionNavigationRow } from "../../ui/navigation/session-navigation"
import {
  applyFetchedSessionListPage,
  sessionListQueryKey,
  sessionListQueryOptions,
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
 */
export type SessionSource =
  | { kind: "local" | "cloud" }
  | { kind: "user-hosted"; workspaceId: string; projectId?: string }

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
export function centralSessionSource(input: { local: boolean }): SessionSource {
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
 * One rail section's list, from its workspace's source.
 *
 * Every source writes the SAME cache entry (`shell.sessionList` for the
 * section's query), so the readers, the pagination and the event appliers in
 * `session-list.ts` stay one implementation whichever server answered.
 */
export function sessionSourceQueryOptions(input: {
  baseUrl?: string
  source: SessionSource
  query: SessionListQuery
  request?: typeof fetch
}) {
  if (input.source.kind !== USER_HOSTED_WORKSPACE_KIND) {
    return sessionListQueryOptions({
      baseUrl: input.baseUrl,
      query: input.query,
      ...(input.request ? { request: input.request } : {}),
    })
  }
  const source = input.source
  return queryOptions({
    queryKey: sessionListQueryKey(input.baseUrl, input.query),
    queryFn: async () => applyFetchedSessionListPage({
      baseUrl: input.baseUrl,
      query: input.query,
      page: sessionListPage(
        await userHostedSessionRows({
          baseUrl: input.baseUrl,
          source,
          ...(input.request ? { request: input.request } : {}),
        }),
        input.query,
      ),
    }),
  })
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
  const matched = rows
    .filter((row) => rowMatchesView(row, query))
    .sort((a, b) => sort === "created_desc"
      ? b.createdAt - a.createdAt || b.sessionRef.localeCompare(a.sessionRef)
      : b.updatedAt - a.updatedAt || b.sessionRef.localeCompare(a.sessionRef))
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
