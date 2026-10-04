/**
 * What a failed turn tells the operator to do. `rate_limit` is a temporary
 * refusal (HTTP 429, "try again later") that the same account clears by
 * waiting; `usage_limit` is an exhausted plan or quota window that only another
 * model or account gets past until it resets.
 */
export const FIRST_TURN_ERROR_CLASSES = ["credential", "harness", "model", "rate_limit", "usage_limit", "workspace", "session", "unknown"] as const

export type FirstTurnErrorClass = (typeof FIRST_TURN_ERROR_CLASSES)[number]
