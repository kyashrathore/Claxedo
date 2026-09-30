import type { HostedAccount } from "./account"
import type { ProjectId, SessionId } from "./ids"
import type { SessionContext } from "./session-context"
import { readSessionSources, type SessionSource, type SourcePage } from "./session-sources"
import { withQuery } from "./transport"
import type { ListedStatus } from "./status-types"
import type { SessionListInput, SessionPage, SessionRow } from "./types"
import { listedStatusFromListItem, sessionRowFromListItem } from "./wire/session-row"

const SORT = "human_turn_desc"

async function listedOf(context: SessionContext, items: readonly unknown[]) {
  const { address } = context.workspaces
  const rows: SessionRow[] = []
  const statuses = new Map<SessionId, ListedStatus>()
  for (const item of items) {
    let row = sessionRowFromListItem(item, address)
    const directory = (item as { directory?: unknown }).directory
    if (!row && typeof directory === "string") {
      await context.workspaces.learn(directory)
      row = sessionRowFromListItem(item, address)
    }
    if (!row) continue
    rows.push(row)
    const listed = listedStatusFromListItem(item)
    if (listed) statuses.set(row.ref.sessionId, { ...listed, status: context.status.listed(row.ref, listed.status) })
  }
  return { rows, statuses }
}

function sourcePage(body: { items?: unknown; nextAfter?: unknown }): SourcePage {
  return { items: Array.isArray(body.items) ? body.items : [], ...(typeof body.nextAfter === "string" ? { nextAfter: body.nextAfter } : {}) }
}

function serverSource(context: SessionContext, projectId: ProjectId, limit: number): SessionSource {
  const { transport } = context
  const listPath = transport.loopback ? "/api/claxedo/session-list" : "/api/control/session-list"
  return {
    required: true,
    read: async (after) => sourcePage(await transport.json(withQuery(listPath, { scope: "project", projectId, sort: SORT, limit, after }))),
  }
}

function accountSource(account: HostedAccount, projectId: ProjectId, limit: number): SessionSource {
  return {
    required: false,
    read: async (after) => sourcePage(await account.run("session.page", { projectId, limit, sort: SORT, ...(after ? { after } : {}) })),
  }
}

function sourcesOf(context: SessionContext, projectId: ProjectId, limit: number): SessionSource[] {
  const accountIds = context.account ? context.workspaces.accountProjectIds(projectId) : []
  const accountOnly = accountIds.includes(projectId)
  const account = context.account
  return [
    ...(accountOnly ? [] : [serverSource(context, projectId, limit)]),
    ...(account ? accountIds.map((id) => ({ ...accountSource(account, id, limit), required: accountOnly })) : []),
  ]
}

export async function listSessions(context: SessionContext, options: SessionListInput): Promise<SessionPage> {
  const merged = await readSessionSources(sourcesOf(context, options.projectId, options.limit), options.limit, options.after)
  return {
    ...(await listedOf(context, merged.items)),
    ...(merged.nextAfter ? { nextAfter: merged.nextAfter } : {}),
    ...(merged.degraded ? { degraded: true } : {}),
  }
}
