/**
 * What a session share grants its recipient.
 *
 * `follow` is read and live stream. `send` adds prompting the agent and
 * answering its permission and question prompts — every operation the runtime
 * classes as a session write.
 *
 * The runtime asks the authority on every request and on every turn-lease
 * renewal, so a downgrade needs no revocation: the next write and the next
 * renewal are refused. Revoking the grant is what ends reading.
 */
export const SESSION_SHARE_LEVELS = ["follow", "send"] as const

export type SessionShareLevel = (typeof SESSION_SHARE_LEVELS)[number]

/** A grant that names no level reads and streams only. */
export const DEFAULT_SESSION_SHARE_LEVEL: SessionShareLevel = "follow"

export function isSessionShareLevel(value: unknown): value is SessionShareLevel {
  return SESSION_SHARE_LEVELS.some((level) => level === value)
}

/**
 * The level a caller asked for. Absent is `follow`; any other unknown value is
 * refused rather than narrowed, so a typo cannot silently grant less than the
 * granter chose or more than they meant.
 */
export function requestedSessionShareLevel(value: unknown): SessionShareLevel {
  if (value === undefined || value === null) return DEFAULT_SESSION_SHARE_LEVEL
  if (!isSessionShareLevel(value)) throw new Error("session_share_level_invalid")
  return value
}

/** The level a stored grant carries. A row written before the column reads as `follow`. */
export function storedSessionShareLevel(value: unknown): SessionShareLevel {
  return isSessionShareLevel(value) ? value : DEFAULT_SESSION_SHARE_LEVEL
}
