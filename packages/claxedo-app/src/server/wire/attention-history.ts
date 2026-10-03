import { asRecord, isNonNegativeSafeInteger } from "@claxedo/helpers/guards"
import type { HostedAccount } from "../account"
import { contractMismatch } from "../errors"
import { withQuery, type Transport } from "../transport"
import { raisedSessionNotice, sessionNoticeIdentity } from "./session-notices"

export type AttentionHistoryPage = {
  readonly frames: readonly Record<string, unknown>[]
  readonly through: number
  readonly next?: number
}

export function attentionHistoryPage(raw: unknown, after: number): AttentionHistoryPage {
  const page = asRecord(raw)
  if (!page || !Array.isArray(page.events) || !isNonNegativeSafeInteger(page.through) || page.through < after) throw contractMismatch("Session attention history is invalid")
  const through = page.through
  if (page.next !== undefined && (!isNonNegativeSafeInteger(page.next) || page.next <= after || page.next > page.through)) throw contractMismatch("Session attention history cursor is invalid")
  let previous = after
  const frames = page.events.map((entry: unknown) => {
    const event = asRecord(entry)
    if (!event || !isNonNegativeSafeInteger(event.cursor) || event.cursor <= previous || event.cursor > through) throw contractMismatch("Session attention history order is invalid")
    sessionNoticeIdentity(event)
    raisedSessionNotice(event)
    previous = event.cursor
    return { ...event, type: "session.attention.raised", replayed: true }
  })
  return { frames, through, ...(page.next !== undefined ? { next: page.next } : {}) }
}

export function readLocalAttention(transport: Transport, after: number, signal: AbortSignal) {
  return transport.json(withQuery("/api/claxedo/session-attention", { after, limit: 256 }), { signal })
}

export function readHostedAttention(transport: Transport, account: HostedAccount | undefined, after: number, signal: AbortSignal) {
  return account ? account.run("session.attention.history", { after, limit: 256 })
    : transport.json(withQuery("/api/control/session-attention", { after, limit: 256 }), { signal })
}

export function sessionShareChanged(frame: { readonly type: string }): boolean {
  return frame.type === "session.share.changed"
}
