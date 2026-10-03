import { parseSessionReader, type SessionReaderCommand } from "@claxedo/agent-runtime-contract"
import { asRecord } from "@claxedo/helpers/guards"
import { contractMismatch } from "./errors"
import type { SessionContext } from "./session-context"
import { listedOf } from "./session-list"
import { readSessionSources, type SessionSource } from "./session-sources"
import { jsonInit, withQuery } from "./transport"
import type { SessionInventoryInput, SessionInventoryPage, SessionLocation } from "./types"

function totalOf(input: unknown): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) throw contractMismatch("Session inventory total is missing")
  return input
}

async function readInventorySourcePages(context: SessionContext, input: SessionInventoryInput) {
  await context.workspaces.load()
  const totals = new Map<(after: string | undefined) => Promise<unknown>, number>()
  const errors: unknown[] = []
  const query = { ...input, sort: "human_turn_desc" }
  const source = (read: (after: string | undefined) => Promise<unknown>): SessionSource => ({
    required: false,
    read: async (after) => {
      try {
        const body = asRecord(await read(after))
        if (!body || !Array.isArray(body.items)) throw contractMismatch("Session inventory rows are missing")
        totals.set(read, totalOf(body.totalKnown))
        return { items: body.items, ...(typeof body.nextAfter === "string" ? { nextAfter: body.nextAfter } : {}) }
      } catch (error) { errors.push(error); throw error }
    },
  })
  const sources = [
    ...(context.transport.loopback ? [source((after) => context.transport.json(withQuery("/api/claxedo/session-list", { ...query, scope: "all", after, excludeWorkspaces: (context.workspaces.accountWorkspaceIds().join(",") || undefined) })))] : []),
    ...(context.account ? [source(async (after) => { await context.workspaces.shared.load(); return context.account!.run("session.inventory", { ...query, after }) })] : !context.transport.loopback ? [source((after) => context.transport.json(withQuery("/api/control/session-list", { ...query, scope: "all", after })))] : []),
  ]
  const merged = await readSessionSources(sources, input.limit, input.after)
  if (totals.size === 0) throw errors[0] ?? contractMismatch("Session inventory is unavailable")
  return { merged, totalKnown: [...totals.values()].reduce((total, count) => total + count, 0) }
}

export async function readSessionInventory(context: SessionContext, input: SessionInventoryInput): Promise<SessionInventoryPage> {
  const { merged, totalKnown } = await readInventorySourcePages(context, input)
  return { ...(await listedOf(context, merged.items)), totalKnown, nextAfter: merged.nextAfter, degraded: merged.degraded }
}

export async function writeReader(context: SessionContext, ref: SessionLocation, command: SessionReaderCommand) {
  const { route } = await context.workspaces.home(ref)
  const workspaceId = route.workspaceId
  if (!workspaceId) throw contractMismatch("Session workspace is missing")
  const hosted = !context.transport.loopback || context.workspaces.accountWorkspaceIds().includes(workspaceId) || context.workspaces.shared.find(ref) !== undefined
  const body = context.account && hosted
    ? await context.account.run("session.reader", { sessionId: ref.sessionId, workspaceId, ...command })
    : await context.transport.json<unknown>(withQuery(`${hosted ? "/api/control/sessions" : "/api/claxedo/session"}/${encodeURIComponent(ref.sessionId)}/reader`, { workspaceId }), jsonInit("POST", command))
  const row = asRecord(body)
  const state = row?.ok === true ? parseSessionReader(row.state) : undefined
  if (!state) throw contractMismatch("Session reader update was refused")
  return state
}
