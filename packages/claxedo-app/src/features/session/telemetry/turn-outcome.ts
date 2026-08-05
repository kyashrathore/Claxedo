/**
 * Turn outcomes — whether the agent actually answered.
 *
 * `prompt_sent` records that someone asked for something. Nothing recorded
 * whether they got it: the only completion signal in the app was the
 * onboarding funnel's `first_turn_ok`/`first_turn_failed`, which covers one
 * turn per user and is gated off entirely for self-host deployments
 * (`features/onboarding/funnel.ts` drops every event unless `ossOptIn`).
 * "What fraction of turns fail, and why" — the single most useful health
 * question about this product — was therefore unanswerable.
 *
 * This module generalizes that classifier past the first turn. It is pure and
 * Solid-free so the settle/dedupe rules can be tested directly rather than
 * through a reactive harness.
 *
 * PRIVACY: a failed turn's error carries provider text, and provider text
 * quotes prompts, file paths and repository names. So the failure CLASS ships
 * and the message never does. The class comes from `sessionRecoveryClass` —
 * either the server-stamped `error.data.firstTurnErrorClass` or a local regex
 * over the message — so classifying costs nothing and leaks nothing. The
 * accompanying test asserts the exact key set for this reason.
 */
import { sessionRecoveryClass, type FirstTurnMessage, type SessionErrorClass } from "../onboarding/first-turn-recovery"

export type TurnOutcomeEvent = {
  name: "turn_completed" | "turn_failed"
  /** The user message that opened the turn. Also the dedupe key. */
  userMessageId: string
  properties: {
    is_first_turn: boolean
    duration_ms?: number
    failure_class?: SessionErrorClass
  }
}

/**
 * A turn is settled exactly when the assistant either finished or failed —
 * the same condition `firstTurnOutcome` uses. An assistant message that is
 * still streaming has neither `time.completed` nor `error`, and must not be
 * reported: emitting there would count every in-flight turn as complete.
 */
function settled(assistant: Extract<FirstTurnMessage, { role: "assistant" }>): boolean {
  return typeof assistant.time.completed === "number" || assistant.error !== undefined
}

/**
 * Every settled turn in the transcript, oldest first, excluding any whose user
 * message id is already in `emitted`.
 *
 * The caller owns the `emitted` set (and is expected to add to it) because the
 * transcript is re-scanned on every message change: a turn that settled three
 * renders ago is still present and still settled, so without the set it would
 * be reported on every subsequent keystroke.
 */
export function turnOutcomeEvents(
  messages: readonly FirstTurnMessage[],
  emitted: ReadonlySet<string>,
): TurnOutcomeEvent[] {
  const assistantByParent = new Map<string, Extract<FirstTurnMessage, { role: "assistant" }>>()
  for (const message of messages) {
    // First assistant reply wins: a retried turn appends another assistant
    // message under the same parent, and the turn's outcome is the first one
    // that settled, not the latest render.
    if (message.role === "assistant" && !assistantByParent.has(message.parentID)) {
      assistantByParent.set(message.parentID, message)
    }
  }

  const events: TurnOutcomeEvent[] = []
  let index = 0
  for (const message of messages) {
    if (message.role !== "user") continue
    const isFirst = index === 0
    index += 1
    if (emitted.has(message.id)) continue
    const assistant = assistantByParent.get(message.id)
    if (!assistant || !settled(assistant)) continue

    const completed = assistant.time.completed
    // Clock skew between client and server can make this negative; a negative
    // duration is worse than none, so drop it rather than record nonsense.
    const duration = typeof completed === "number" ? completed - message.time.created : undefined
    const durationProperty = typeof duration === "number" && duration >= 0 ? { duration_ms: duration } : {}

    events.push(
      assistant.error === undefined
        ? {
            name: "turn_completed",
            userMessageId: message.id,
            properties: { is_first_turn: isFirst, ...durationProperty },
          }
        : {
            name: "turn_failed",
            userMessageId: message.id,
            properties: {
              is_first_turn: isFirst,
              ...durationProperty,
              failure_class: sessionRecoveryClass(assistant.error),
            },
          },
    )
  }
  return events
}
