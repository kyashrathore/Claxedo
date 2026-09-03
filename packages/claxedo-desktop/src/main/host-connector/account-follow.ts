import type { AccountState } from "../account/account-service"

/**
 * What remote access does when the account changes.
 *
 * Remote access follows the account's VERDICTS, not its reachability. A
 * deployment that could not be reached has said nothing about the credential:
 * the account marks that `transient`, the held session survives, and the
 * connector keeps beating — its own heartbeat already distinguishes a rejected
 * credential (it stops) from an unreachable control plane (it carries on), so
 * fail-closed holds without stopping on silence. Stopping on silence is what
 * turned one connection reset into a machine that stayed offline: the one
 * resume attempt then had to enroll against the same slow control plane and
 * timed out.
 *
 *   suspend — the account is genuinely gone (signed out, refused, storage
 *             lost): stop, remembering it was not the user's decision.
 *   resume  — the account is back after such a stop.
 *   hold    — nothing to do: still signed, or a transient outage.
 */
export function remoteAccessFollow(previous: AccountState, next: AccountState): "suspend" | "resume" | "hold" {
  if (previous.status === "signed" && lost(next)) return "suspend"
  if (lost(previous) && next.status === "signed") return "resume"
  return "hold"
}

/** A verdict against the account, as opposed to silence from the deployment. */
function lost(state: AccountState): boolean {
  return state.status !== "signed" && !(state.status === "unavailable" && state.transient)
}
