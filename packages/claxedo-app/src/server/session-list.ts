import type { HostedAccount } from "./account"
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

function serverSource(context: SessionContext, projectId: ProjectId, query: PageQuery): SessionSource {
  const { transport } = context
  const listPath = transport.loopback ? "/api/claxedo/session-list" : "/api/control/session-list"
  return {
    required: true,
    read: async (after) => sourcePage(await transport.json(withQuery(listPath, { scope: "project", projectId, sort: SORT, ...query, after }))),
  }
}

function accountSource(account: HostedAccount, projectId: ProjectId, query: PageQuery, readers: AccountReaders): SessionSource {
  return {
    required: false,
    read: async (after) => {
      const page = sourcePage(await account.run("session.page", { projectId, ...query, sort: SORT, ...(after ? { after } : {}) }))
      for (const item of page.items) readers.set(itemField(item, "sessionId") ?? "", readerFromWire(item))
      return page
    },
  }
}

function sourcesOf(context: SessionContext, projectId: ProjectId, accountIds: readonly ProjectId[], query: PageQuery, readers: AccountReaders): SessionSource[] {
  const accountOnly = accountIds.includes(projectId)
  const account = context.account
  return [
    ...(accountOnly ? [] : [serverSource(context, projectId, query)]),
    ...(account ? accountIds.map((id) => ({ ...accountSource(account, id, query, readers), required: accountOnly })) : []),
  ]
}

export async function listSessions(context: SessionContext, options: SessionListInput): Promise<SessionPage> {
  const accountIds = context.account ? context.workspaces.accountProjectIds(options.projectId) : []
  const paired = accountIds.length > 0 && !accountIds.includes(options.projectId)
  const account: AccountReaders = new Map()
  const query: PageQuery = { limit: options.limit, settled: paired ? "all" : options.settled }
  const hidden = paired && options.settled === "active" ? (item: unknown) => settledItem(context, item, account) : undefined
  const merged = await readSessionSources(sourcesOf(context, options.projectId, accountIds, query, account), options.limit, options.after, hidden)
  return {
    ...(await listedOf(context, merged.items, account)),
    ...(merged.nextAfter ? { nextAfter: merged.nextAfter } : {}),
    ...(merged.degraded ? { degraded: true } : {}),
  }
}
