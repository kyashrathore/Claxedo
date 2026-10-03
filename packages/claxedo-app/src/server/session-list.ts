import type { ProjectId, SessionId } from "./ids"
import type { SessionContext } from "./session-context"
import { accountHoldsReader, sessionSettled } from "./session-reader"
import { readSessionSources, type SessionSource, type SourcePage } from "./session-sources"
import { withQuery } from "./transport"
import type { ListedStatus } from "./status-types"
import type { SessionListInput, SessionPage, SessionReader, SessionRow, SettledFilter } from "./types"
import { lastTurnFromWire, listedStatusFromListItem, readerFromWire, sessionRowFromListItem } from "./wire/session-row"

const SORT = "human_turn_desc"

type PageQuery = { readonly limit: number; readonly settled: SettledFilter }

type AccountReaders = Map<string, SessionReader>

function itemField(item: unknown, key: "sessionId" | "workspaceId"): string | undefined {
  const value = (item as Record<string, unknown>)[key]
  return typeof value === "string" ? value : undefined
}

function listedReader(context: SessionContext, item: unknown, account: AccountReaders): SessionReader | undefined {
  if (!accountHoldsReader(context, itemField(item, "workspaceId"), false)) return readerFromWire(item)
  return account.get(itemField(item, "sessionId") ?? "")
}

function settledItem(context: SessionContext, item: unknown, account: AccountReaders): boolean {
  const reader = listedReader(context, item, account)
  const row = item as { lastHumanTurnAt?: unknown; lastTurn?: unknown }
  const lastHumanTurnAt = typeof row.lastHumanTurnAt === "number" ? row.lastHumanTurnAt : undefined
  return reader !== undefined && sessionSettled({ lastHumanTurnAt, lastTurn: lastTurnFromWire(row.lastTurn) }, reader)
}

async function listedOf(context: SessionContext, items: readonly unknown[], account: AccountReaders) {
  const { address } = context.workspaces
  const rows: SessionRow[] = []
  const statuses = new Map<SessionId, ListedStatus>()
  const readers = new Map<SessionId, SessionReader>()
  for (const item of items) {
    let row = sessionRowFromListItem(item, address)
    const directory = (item as { directory?: unknown }).directory
    if (!row && typeof directory === "string") {
      await context.workspaces.learn(directory)
      row = sessionRowFromListItem(item, address)
    }
    if (!row && itemField(item, "workspaceId")) {
      await context.workspaces.shared.load()
      row = sessionRowFromListItem(item, address)
    }
    if (!row) continue
    rows.push(row)
    const reader = listedReader(context, item, account)
    if (reader) readers.set(row.ref.sessionId, reader)
    const listed = listedStatusFromListItem(item)
    if (listed) statuses.set(row.ref.sessionId, { ...listed, status: context.status.listed(row.ref, listed.status) })
  }
  return { rows, statuses, readers }
}

function sourcePage(body: { items?: unknown; nextAfter?: unknown }): SourcePage {
  return { items: Array.isArray(body.items) ? body.items : [], ...(typeof body.nextAfter === "string" ? { nextAfter: body.nextAfter } : {}) }
}

type ScopeParams = Readonly<Record<string, string>>

function serverSource(context: SessionContext, scope: ScopeParams, query: PageQuery): SessionSource {
  const { transport } = context
  const listPath = transport.loopback ? "/api/claxedo/session-list" : "/api/control/session-list"
  return {
    required: true,
    read: async (after) => sourcePage(await transport.json(withQuery(listPath, { ...scope, sort: SORT, ...query, after }))),
  }
}

function accountSource(read: (after: string | undefined) => Promise<unknown>, readers: AccountReaders): SessionSource {
  return {
    required: false,
    read: async (after) => {
      const page = sourcePage((await read(after)) as { items?: unknown; nextAfter?: unknown })
      for (const item of page.items) readers.set(itemField(item, "sessionId") ?? "", readerFromWire(item))
      return page
    },
  }
}

function projectSources(context: SessionContext, projectId: ProjectId, accountIds: readonly ProjectId[], query: PageQuery, readers: AccountReaders): SessionSource[] {
  const accountOnly = accountIds.includes(projectId)
  const account = context.account
  const linked = account
    ? accountIds.map((id) => ({ ...accountSource((after) => account.run("session.page", { projectId: id, ...query, sort: SORT, ...(after ? { after } : {}) }), readers), required: accountOnly }))
    : []
  return [...(accountOnly ? [] : [serverSource(context, { scope: "project", projectId }, query)]), ...linked]
}

function everySources(context: SessionContext, sessionId: SessionId | undefined, query: PageQuery, readers: AccountReaders): SessionSource[] {
  const account = context.transport.loopback ? context.account : undefined
  const one: ScopeParams = sessionId ? { sessionId } : {}
  const linked = account ? [accountSource((after) => account.run("session.activity.page", { ...query, ...one, sort: SORT, ...(after ? { after } : {}) }), readers)] : []
  return [serverSource(context, { scope: "all", ...one }, query), ...linked]
}

export async function listSessions(context: SessionContext, options: SessionListInput): Promise<SessionPage> {
  const project = "projectId" in options ? options.projectId : undefined
  const accountIds = project && context.account ? context.workspaces.accountProjectIds(project) : []
  const paired = project ? accountIds.length > 0 && !accountIds.includes(project) : context.transport.loopback && context.account !== undefined
  const account: AccountReaders = new Map()
  const query: PageQuery = { limit: options.limit, settled: paired ? "all" : options.settled }
  const hidden = paired && options.settled === "active" ? (item: unknown) => settledItem(context, item, account) : undefined
  const sources = project ? projectSources(context, project, accountIds, query, account) : everySources(context, "sessionId" in options ? options.sessionId : undefined, query, account)
  const merged = await readSessionSources(sources, options.limit, options.after, hidden)
  return {
    ...(await listedOf(context, merged.items, account)),
    ...(merged.nextAfter ? { nextAfter: merged.nextAfter } : {}),
    ...(merged.degraded ? { degraded: true } : {}),
  }
}
