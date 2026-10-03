export type SessionOutcomePosition = {
  sequence: number
  status: "completed" | "failed" | "cancelled"
  completedAt: number
}

export type SessionAttentionFacts = {
  sequence: number
  generation: number
  activitySequence: number
  activityAt: number
  outcome?: SessionOutcomePosition
  working: boolean
  awaitingInput: boolean
}

export type SessionActivityFilter = "all" | "working" | "needs-you"

export function matchesSessionActivity(facts: SessionAttentionFacts | undefined, filter: SessionActivityFilter): boolean {
  const working = facts?.working === true && !facts.awaitingInput
  return filter === "all" || (filter === "working" ? working : !working)
}

export type SessionReaderState = {
  generation: number
  revision: number
  seenThrough: number
  seenAt?: number
  settledThrough?: number
  settledAt?: number
}

export type SessionReaderCommand = { generation: number } & (
  | { kind: "seen"; outcomeSequence: number }
  | { kind: "settle"; activitySequence: number; outcomeSequence?: number; revision: number }
  | { kind: "return"; revision: number }
)

export type SessionReaderResult =
  | { ok: true; state: SessionReaderState }
  | { ok: false; reason: "generation_changed" | "reader_changed" | "activity_changed" | "invalid_outcome" | "working" | "awaiting_input" }

export function sessionAttention(facts: SessionAttentionFacts, reader?: SessionReaderState): {
  unseen: boolean
  settled: boolean
} {
  const current = reader?.generation === facts.generation ? reader : undefined
  const unseen = facts.outcome !== undefined && facts.outcome.status !== "cancelled"
    && facts.outcome.sequence > (current?.seenThrough ?? 0)
  const settled = !facts.working && !facts.awaitingInput && current?.settledThrough !== undefined
    && current.settledThrough === facts.activitySequence
  return { unseen, settled }
}

export function updateSessionReader(
  facts: SessionAttentionFacts,
  previous: SessionReaderState | undefined,
  command: SessionReaderCommand,
  now: number,
): SessionReaderResult {
  if (command.generation !== facts.generation) return { ok: false, reason: "generation_changed" }
  const state = previous?.generation === facts.generation
    ? previous
    : { generation: facts.generation, revision: 0, seenThrough: 0 }
  if (command.kind !== "seen" && command.revision !== state.revision) return { ok: false, reason: "reader_changed" }
  if (command.kind === "return") {
    const { settledThrough: _position, settledAt: _at, ...active } = state
    return { ok: true, state: { ...active, revision: state.revision + 1 } }
  }
  const outcome = command.outcomeSequence
  if (outcome !== undefined && (!Number.isSafeInteger(outcome) || outcome < 0 || outcome > (facts.outcome?.sequence ?? 0))) {
    return { ok: false, reason: "invalid_outcome" }
  }
  if (command.kind === "settle") {
    if (facts.awaitingInput) return { ok: false, reason: "awaiting_input" }
    if (facts.working) return { ok: false, reason: "working" }
    if (command.activitySequence !== facts.activitySequence) return { ok: false, reason: "activity_changed" }
    if (outcome !== facts.outcome?.sequence) return { ok: false, reason: "activity_changed" }
  }
  const seenThrough = Math.max(state.seenThrough, outcome ?? 0)
  if (command.kind === "seen" && seenThrough === state.seenThrough) return { ok: true, state }
  return {
    ok: true,
    state: {
      ...state,
      revision: state.revision + 1,
      seenThrough,
      ...(seenThrough > state.seenThrough ? { seenAt: now } : {}),
      ...(command.kind === "settle" ? { settledThrough: command.activitySequence, settledAt: now } : {}),
    },
  }
}

export type SessionAttentionEvent = {
  sequence: number
  kind: "outcome" | "question" | "permission"
  openedAt: number
  outcome?: "completed" | "failed" | "cancelled"
  requestId?: string
}

export type SessionAttentionPage = {
  generation: number
  through: number
  events: SessionAttentionEvent[]
  next?: number
}
