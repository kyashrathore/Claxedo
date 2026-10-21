import type { SessionHarness } from "@claxedo/agent-runtime-contract"

export type SessionModelReference = { providerID: string; modelID: string }

/** What a started session runs. `effort` null leaves the model's own default; the runtime's wire field for it is `variant`. */
export type SessionModelConfiguration = { harness: SessionHarness; model: SessionModelReference; effort: string | null }

export const SESSION_START_BLOCKER_CODES = [
  "placement_unsupported",
  "harness_unavailable",
  "model_unavailable",
  "effort_unsupported",
  "capability_unavailable",
  "source_unavailable",
  "rate_limited",
] as const
export type SessionStartBlockerCode = (typeof SESSION_START_BLOCKER_CODES)[number]

/** Why a start cannot run where it would run, in a sentence the person reads. */
export type SessionStartBlocker = { code: SessionStartBlockerCode; detail: string }

export const SESSION_BRIDGE_FAILURE_CODES = ["invalid_input", "forbidden", "conflict", "unsupported", "rate_limited"] as const
export type SessionBridgeFailureCode = (typeof SESSION_BRIDGE_FAILURE_CODES)[number]

export type SessionBridgeFailure = { code: SessionBridgeFailureCode; message: string }

export type SessionBridgeRefusal = { ok: false; error: SessionBridgeFailure }

export type SessionBridgeResult<T> = ({ ok: true } & T) | SessionBridgeRefusal

export function sessionBridgeRefusal(code: SessionBridgeFailureCode, message: string): SessionBridgeRefusal {
  return { ok: false, error: { code, message } }
}

/** A start whose destination refused it, as the caller's failure: the first blocker's sentence, or a generic one when none was named. */
export function unstartable(blockers: readonly SessionStartBlocker[]): SessionBridgeRefusal {
  const blocker = blockers[0]
  return sessionBridgeRefusal(
    blocker?.code === "rate_limited" ? "rate_limited" : "unsupported",
    blocker ? blocker.detail : "This configuration cannot be started here",
  )
}
