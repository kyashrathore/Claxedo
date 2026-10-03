import { readArray, readField, readFiniteNumber, readString } from "@claxedo/helpers/readers"
import type { ProjectId, SessionId } from "./ids"
import type { SessionContext } from "./session-context"
import { accountHoldsReader, sessionSettled } from "./session-reader"
import { readSessionSources, type MergedPage, type SessionSource, type SourcePage } from "./session-sources"
import { withQuery } from "./transport"
import type { ListedStatus } from "./status-types"
import type { SessionListInput, SessionPage, SessionReader, SessionRow, SettledFilter } from "./types"
import { lastTurnFromWire, listedStatusFromListItem, readerFromWire, SESSION_LIST_SORT, sessionHostRootFromListItem, sessionRowFromListItem } from "./wire/session-row"

type PageQuery = { readonly limit: number; readonly settled: SettledFilter }

type AccountReaders = Map<string, SessionReader>

function listedReader(context: SessionContext, item: unknown, account: AccountReaders): SessionReader | undefined {
  if (!accountHoldsReader(context, readString(item, "workspaceId"), false)) return readerFromWire(item)
  return account.get(readString(item, "sessionId") ?? "")
}

function settledItem(context: SessionContext, item: unknown, account: AccountReaders): boolean {
  const reader = listedReader(context, item, account)
  const lastHumanTurnAt = readFiniteNumber(item, "lastHumanTurnAt")
  return reader !== undefined && sessionSettled({ lastHumanTurnAt, lastTurn: lastTurnFromWire(readField(item, "lastTurn")) }, reader)
}

async function listedOf(context: SessionContext, items: readonly unknown[], account: AccountReaders) {
  const { address } = context.workspaces
  const rows: SessionRow[] = []
  const statuses = new Map<SessionId, ListedStatus>()
  const readers = new Map<SessionId, SessionReader>()
  for (const item of items) {
    let row = sessionRowFromListItem(item, address)
    const directory = readString(item, "directory")
    if (!row && directory !== undefined) {
      await context.workspaces.learn(directory)
      row = sessionRowFromListItem(item, address)
    }
    if (!row && readString(item, "workspaceId")) {
      await context.workspaces.shared.load()
      row = sessionRowFromListItem(item, address)
    }
    if (!row) continue
    context.workspaces.hostSession(row.ref, sessionHostRootFromListItem(item))
    rows.push(row)
    const reader = listedReader(context, item, account)
    if (reader) readers.set(row.ref.sessionId, reader)
    const listed = listedStatusFromListItem(item)
    if (listed) statuses.set(row.ref.sessionId, { ...listed, status: context.status.listed(row.ref, listed.status) })
  }
  return { rows, statuses, readers }
}

function sourcePage(body: unknown): SourcePage {
  const nextAfter = readString(body, "nextAfter")
  return { items: readArray(body, "items") ?? [], ...(nextAfter !== undefined ? { nextAfter } : {}) }
}

type ScopeParams = Readonly<Record<string, string>>

function serverSource(context: SessionContext, scope: ScopeParams, query: PageQuery): SessionSource {
  const { transport } = context
  const listPath = transport.loopback ? "/api/claxedo/session-list" : "/api/control/session-list"
  return {
    required: true,
    read: async (after) => sourcePage(await transport.json(withQuery(listPath, { ...scope, sort: SESSION_LIST_SORT, ...query, after }))),
  }
}

function accountSource(read: (after: string | undefined) => Promise<unknown>, readers: AccountReaders): SessionSource {
  return {
    required: false,
    read: async (after) => {
      const page = sourcePage(await read(after))
      for (const item of page.items) readers.set(readString(item, "sessionId") ?? "", readerFromWire(item))
      return page
    },
  }
}

function projectSources(context: SessionContext, projectId: ProjectId, accountIds: readonly ProjectId[], query: PageQuery, readers: AccountReaders): SessionSource[] {
  const accountOnly = accountIds.includes(projectId)
  const account = context.account
  const linked = account
    ? accountIds.map((id) => ({ ...accountSource((after) => account.run("session.page", { projectId: id, ...query, sort: SESSION_LIST_SORT, ...(after ? { after } : {}) }), readers), required: accountOnly }))
    : []
  return [...(accountOnly ? [] : [serverSource(context, { scope: "project", projectId }, query)]), ...linked]
}

function everySources(context: SessionContext, sessionId: SessionId | undefined, query: PageQuery, readers: AccountReaders): SessionSource[] {
  const account = context.transport.loopback ? context.account : undefined
  const one: ScopeParams = sessionId ? { sessionId } : {}
  const server = serverSource(context, { scope: "all", ...one }, query)
  if (!account) return [server]
  const machineOnly: SessionSource = {
    ...server,
    read: async (after) => {
      const page = await server.read(after)
      return { ...page, items: page.items.filter((item) => !accountHoldsReader(context, readString(item, "workspaceId"), false)) }
    },
  }
  return [machineOnly, accountSource((after) => account.run("session.activity.page", { ...query, ...one, sort: SESSION_LIST_SORT, ...(after ? { after } : {}) }), readers)]
}

async function pageOf(context: SessionContext, merged: MergedPage, readers: AccountReaders): Promise<SessionPage> {
  return {
    ...(await listedOf(context, merged.items, readers)),
    ...(merged.nextAfter ? { nextAfter: merged.nextAfter } : {}),
    ...(merged.degraded ? { degraded: true } : {}),
  }
}

export async function listSessions(context: SessionContext, options: SessionListInput): Promise<SessionPage> {
  const account: AccountReaders = new Map()
  if (!("projectId" in options)) {
    const sources = everySources(context, options.sessionId, { limit: options.limit, settled: options.settled }, account)
    return pageOf(context, await readSessionSources(sources, options.limit, options.after, { fill: false }), account)
  }
  const { projectId } = options
  const accountIds = context.account ? context.workspaces.accountProjectIds(projectId) : []
  const paired = accountIds.length > 0 && !accountIds.includes(projectId)
  const query: PageQuery = { limit: options.limit, settled: paired ? "all" : options.settled }
  const hidden = paired && options.settled === "active" ? (item: unknown) => settledItem(context, item, account) : undefined
  const sources = projectSources(context, projectId, accountIds, query, account)
  return pageOf(context, await readSessionSources(sources, options.limit, options.after, { fill: true, hidden }), account)
}
