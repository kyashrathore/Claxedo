import { queryOptions } from "@tanstack/solid-query"
import { sessionRowDirectory } from "@/platform/identity/workspace-address"
import { getClaxedoServerUrl, normalizeUrl } from "@/platform/api/api"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { agentRuntimeSessionListUrl } from "@/platform/runtime/agent/agent-runtime-urls"
import { createTransport } from "@/platform/runtime/transport"
import { inventoryHostKind, type WorkspaceHostKind } from "@/platform/runtime/placement-wire"
import type { SessionNavigationRow } from "../../ui/navigation/session-navigation"
import type { SessionOwner } from "../query/types"
import { controlPlaneSessionOwners, requestControlPlaneSessions } from "./control-plane-sessions"
import {
  applyFetchedSessionListPage,
  fetchSessionListPage,
  mergeSessionListItems,
  sessionListQueryKey,
  sessionListSortKey,
  type SessionListQuery,
  type SessionListResponse,
} from "../query/session-list"
import { asFiniteNumber, asRecord } from "@claxedo/helpers/guards"

/**
 * Where one workspace's sessions are read from, chosen by the catalog row's
 * `kind` and by nothing else.
 *
 * - `local`: the machine's own daemon, over loopback.
 * - `cloud`: the control plane's registry, which is the authority for the
 *   sessions of a workspace it provisions.
 * - `machine`: the workspace's own runtime, over the relay connection the
 *   app already holds — one hop, role enforced by the relay token. Own and
 *   shared workspaces are the same source; the role only gates affordances.
 *   Which sessions exist is the runtime's answer; who created one is the
 *   control plane's, joined on by `userHostedSessionOwners` below.
 *
 * The registry holds only the machine-placed sessions that were created THROUGH
 * it, so asking it for that workspace's list answers a subset the client cannot
 * tell apart from an empty machine. `claxedo-server`'s session-list route now
 * refuses that read (409 `workspace_runtime_session_authority`) rather than
 * answering it.
 *
 * `composed` is not a host kind: it is a SECTION whose workspaces do not all
 * answer from one server — a project holding a machine-placed workspace beside
 * one this server or the provisioner serves. Its members are the per-workspace sources
 * above, and its page is their pages merged.
 */
export type SessionSource =
  | { kind: "self" | "provisioner" }
  | { kind: "machine"; workspaceId: string; projectId?: string }
  | { kind: "composed"; central: CentralSessionSource; userHosted: UserHostedSessionSource[] }

type CentralSessionSource = Extract<SessionSource, { kind: "self" | "provisioner" }>
type UserHostedSessionSource = Extract<SessionSource, { kind: "machine" }>

/** The composed page's key for the central member's own cursor. */
const COMPOSED_CENTRAL_MEMBER = "central"

/** Rows the runtime answers with are re-shaped once and paged from memory. */
const USER_HOSTED_SESSION_LIST_STALE_MS = 30_000

/**
 * The app's own central server's list: the daemon's on a local surface, the
 * control plane's registry on the hosted web. Global Chat's sessions belong to
 * no workspace and live there, by the same rule that puts a local workspace's
 * sessions on the daemon and a cloud workspace's in the registry.
 */
export function centralSessionSource(input: { local: boolean }): CentralSessionSource {
  return { kind: input.local ? "self" : "provisioner" }
}

export function sessionSourceForWorkspace(input: {
  kind: WorkspaceHostKind | undefined
  workspaceId: string
  projectId?: string
}): SessionSource {
  if (input.kind !== "machine") return { kind: input.kind === "provisioner" ? "provisioner" : "self" }
  return {
    kind: "machine",
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
      kind: inventoryHostKind(workspace.kind),
      // The signed id a relay-backed workspace is addressed by; the catalog's
      // own key is a directory on the HOST, which this app cannot reach.
      workspaceId: workspace.workspaceId ?? workspace.id ?? ref,
      projectId: input.projectId,
    })
    // One workspace is one source however many refs name it; a second read of
    // the same runtime would only duplicate its rows.
    if (source.kind === "machine") byWorkspaceId.set(source.workspaceId, source)
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
  if (source.kind === "machine") {
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
  const parsed = asRecord(parseJson(cursor))
  if (!parsed) return {}
  return Object.fromEntries(Object.entries(parsed)
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
  source: Extract<SessionSource, { kind: "machine" }>
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
        workspace: { kind: "machine", workspaceId: input.source.workspaceId },
        ...(input.request ? { request: input.request, relayRequest: input.request } : {}),
      })
      const list = agentRuntimeSessionListUrl({ serverUrl, roots: true })
      const [rows, owners] = await Promise.all([
        runtime.json(`${list.pathname}${list.search}`),
        userHostedSessionOwners({
          baseUrl: serverUrl,
          workspaceId: input.source.workspaceId,
          ...(input.request ? { request: input.request } : {}),
        }),
      ])
      return (Array.isArray(rows) ? rows : []).flatMap((row) => {
        const item = userHostedNavigationRow(row, input.source, owners)
        return item ? [item] : []
      })
    },
  })
}

/**
 * Who created each of this workspace's sessions, from the control plane.
 *
 * The runtime knows no users: it answers with the sessions on that machine and
 * nothing about who owns one, so a session Alice shared with Bob's team reaches
 * Bob's rail as an anonymous row. Ownership is a control-plane fact — the same
 * grant that let Bob see the session at all — so the creator is joined from the
 * registry's record for that session id, which is the mapping the cloud lane's
 * rows already arrive with. Records for sessions the runtime did not list are
 * ignored: the runtime, not the registry, decides which rows exist.
 *
 * Read inside the workspace row memo so the share doorbell, which already drops
 * that memo, re-reads ownership on the same beat it re-reads the rows.
 *
 * A refused or unreachable registry leaves the rows unowned rather than failing
 * the section: the creator decorates a row, and a rail emptied because an
 * avatar could not be resolved would report a reachable machine as empty.
 */
async function userHostedSessionOwners(input: {
  baseUrl: string
  workspaceId: string
  request?: typeof fetch
}) {
  try {
    return controlPlaneSessionOwners(await requestControlPlaneSessions(input))
  } catch {
    return new Map<string, SessionOwner>()
  }
}

function userHostedNavigationRow(
  row: unknown,
  source: Extract<SessionSource, { kind: "machine" }>,
  owners: ReadonlyMap<string, SessionOwner>,
): SessionNavigationRow | undefined {
  const item = asRecord(row)
  const sessionId = txt(item?.id)
  if (!sessionId) return undefined
  const time = asRecord(item?.time)
  const createdAt = asFiniteNumber(time?.created) ?? 0
  const updatedAt = asFiniteNumber(time?.updated) ?? createdAt
  const lastHumanTurnAt = asFiniteNumber(time?.lastHumanTurn)
  const archivedAt = asFiniteNumber(time?.archived)
  const owner = owners.get(sessionId)
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
    ...(lastHumanTurnAt !== undefined ? { lastHumanTurnAt } : {}),
    ...(archivedAt ? { archivedAt } : {}),
    tags: [],
    attachments: [],
    ...(owner ? { owner } : {}),
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
  // `sessionRef` breaks ties the way the server's own listing does. This builds
  // the page rather than re-ordering one the server built, so it needs the total
  // order, not just the key.
  return [...rows].sort((a, b) => {
    const left = sessionListSortKey(a, sort)
    const right = sessionListSortKey(b, sort)
    for (const [index, value] of left.entries()) {
      const other = right[index] ?? 0
      if (other !== value) return other - value
    }
    return b.sessionRef.localeCompare(a.sessionRef)
  })
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

function txt(input: unknown) {
  return typeof input === "string" && input.trim() ? input.trim() : undefined
}
