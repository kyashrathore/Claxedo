import { sessionEndpoint, type SessionContext } from "./session-context"
import { jsonInit } from "./transport"
import type { SessionLocation, SessionReader, SessionRow } from "./types"
import { readerFromWire } from "./wire/session-row"

export type ReaderWrite =
  | { readonly kind: "seen"; readonly completedAt: number }
  | { readonly kind: "settle"; readonly settled: true; readonly through: number }
  | { readonly kind: "settle"; readonly settled: false }

type Activity = Pick<SessionRow, "lastHumanTurnAt" | "lastTurn">

export function settledThrough(row: Activity | undefined): number {
  return Math.max(row?.lastHumanTurnAt ?? 0, row?.lastTurn?.completedAt ?? 0)
}

export function sessionSettled(row: Activity, reader: SessionReader): boolean {
  return reader.settledAt !== undefined && reader.settledAt >= settledThrough(row)
}

export function accountHoldsReader(context: SessionContext, workspaceId: string | undefined, shared: boolean): boolean {
  if (!context.account || !context.transport.loopback) return false
  return shared || (workspaceId !== undefined && context.workspaces.accountKnows(workspaceId))
}

function writeBody(write: ReaderWrite) {
  if (write.kind === "seen") return { completedAt: write.completedAt }
  return write.settled ? { settled: true, through: write.through } : { settled: false }
}

export async function sendReaderWrite(context: SessionContext, ref: SessionLocation, write: ReaderWrite): Promise<SessionReader> {
  const { route } = await context.workspaces.home(ref)
  const { account, transport } = context
  if (account && accountHoldsReader(context, route.workspaceId, route.sharedSession !== undefined)) {
    const operation = write.kind === "seen" ? "session.seen" : "session.settle"
    return readerFromWire(await account.run(operation, { sessionId: ref.sessionId, ...writeBody(write) }))
  }
  const path = transport.loopback ? `/api/claxedo${sessionEndpoint(ref, `/${write.kind}`)}` : `/api/control/sessions/${encodeURIComponent(ref.sessionId)}/${write.kind}`
  return readerFromWire(await transport.json<unknown>(path, jsonInit("POST", writeBody(write))))
}
