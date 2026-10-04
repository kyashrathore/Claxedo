import type { OutlineTurn } from "@/server"
import type { OutlineState } from "@/session"
import type { TranscriptUserMessage } from "@/transcript"
import type { TimelineNavTurn } from "./timeline"

function outlineNavTurn(turn: OutlineTurn): TimelineNavTurn {
  return { id: turn.id, ...(turn.title ? { summary: { title: turn.title } } : {}), preview: turn.preview }
}

export function navTurns(outline: OutlineState, users: readonly TranscriptUserMessage[]): TimelineNavTurn[] {
  if (outline.kind !== "ready") return [...users]
  const loaded = new Set(users.map((message) => message.id))
  const listed: TimelineNavTurn[] = outline.outline.turns.filter((turn) => !loaded.has(turn.id)).map(outlineNavTurn)
  return [...listed, ...users].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}
