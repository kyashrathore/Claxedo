/**
 * The runtime's turn message-id convention.
 *
 * A turn is two messages: the user's prompt and the reply that answers it. The
 * runtime names the reply from the prompt — `${userMessageId}_r` — and mints it
 * BEFORE any engine has chosen an id of its own, so a turn has a stable reply
 * identity from the moment it is admitted.
 *
 * The convention is what makes the reply id self-describing: a carrier that
 * names only the reply can still recover the message it answers. The
 * runtime event envelope is exactly that carrier — it names the session and
 * the reply and nothing else — so its consumers resolve the parent here rather
 * than each re-deriving the suffix.
 *
 * Both directions live in this one module so the suffix is written once: a
 * mint that drifted from the recovery would silently orphan every reply the
 * lane announces.
 */
const TURN_REPLY_SUFFIX = "_r"

/** The id of the reply that answers `userMessageId`. */
export function assistantMessageIdForTurn(userMessageId: string): string {
  return `${userMessageId}${TURN_REPLY_SUFFIX}`
}

/**
 * The user message `assistantMessageId` answers, or `undefined` when the id
 * was not minted by {@link assistantMessageIdForTurn}. Callers that require a
 * parent must treat `undefined` as a contract violation to report, never as a
 * cue to invent one: an id outside the convention names no user message, and
 * substituting the session's own id fabricates a turn that does not exist.
 */
export function userMessageIdForAssistantReply(assistantMessageId: string): string | undefined {
  if (!assistantMessageId.endsWith(TURN_REPLY_SUFFIX)) return undefined
  return assistantMessageId.slice(0, -TURN_REPLY_SUFFIX.length) || undefined
}

const RANDOM_LENGTH = 14
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

function timeHex(ordered: bigint) {
  let hex = ""
  for (let index = 0; index < 6; index += 1) {
    hex += Number((ordered >> BigInt(40 - 8 * index)) & 0xffn).toString(16).padStart(2, "0")
  }
  return hex
}

function randomBase62(length: number) {
  let out = ""
  for (const byte of crypto.getRandomValues(new Uint8Array(length))) out += BASE62[byte % 62]
  return out
}

/**
 * Mints message ids that sort by creation time. Clients keep a session's
 * messages ordered by id, so an id minted any other way lands out of place in
 * every transcript that shows it.
 */
export function createMessageIds(clock: () => number = Date.now): () => string {
  let lastTimestamp = 0
  let counter = 0
  return () => {
    const now = clock()
    if (now !== lastTimestamp) {
      lastTimestamp = now
      counter = 0
    }
    counter += 1
    return `msg_${timeHex(BigInt(now) * 0x1000n + BigInt(counter))}${randomBase62(RANDOM_LENGTH)}`
  }
}
