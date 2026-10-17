import type { OutlineTurn } from "@/server"
import type { OutlineState } from "@/session"
import type { TranscriptUserMessage } from "@/transcript"
import { compareTurnOrder, messageOrderKey, type TurnOrderKey } from "../transcript/merge"
import type { TimelineNavTurn } from "./timeline"

function outlineNavTurn(turn: OutlineTurn): TimelineNavTurn {
  return { id: turn.id, ...(turn.title ? { summary: { title: turn.title } } : {}), preview: turn.preview }
}

type OrderedNavTurn = { readonly key: TurnOrderKey; readonly turn: TimelineNavTurn }

export function navTurns(outline: OutlineState, users: readonly TranscriptUserMessage[]): TimelineNavTurn[] {
  if (outline.kind !== "ready") return [...users]
  const loaded = new Set(users.map((message) => message.id))
  const listed: OrderedNavTurn[] = outline.outline.turns
    .filter((turn) => !loaded.has(turn.id))
    .map((turn) => ({ key: { id: turn.id, created: turn.createdAt, pending: false }, turn: outlineNavTurn(turn) }))
  const shown: OrderedNavTurn[] = users.map((message) => ({ key: messageOrderKey(message), turn: message }))
  return [...listed, ...shown].sort((left, right) => compareTurnOrder(left.key, right.key)).map((entry) => entry.turn)
}
