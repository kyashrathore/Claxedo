import type { CredentialMetadata } from "@claxedo/server-core/credentials/types"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import type { ControlPlaneCredentials } from "../authority/services"

const log = Log.create({ service: "credential-refusals" })

/**
 * How long one vendor refusal counts towards the next. Two 401s a coffee
 * break apart are two independent events, not a login going bad.
 */
const FAILURE_WINDOW_MS = 5 * 60 * 1000

/** Refusals before the plane alone takes the account off the provider. */
const FAILURES_BEFORE_YIELDING = 2

export type CredentialRefusals = {
  /**
   * A vendor answered 401 to `credential`'s stored value at `revision`. The
   * first refusal of a value is remembered; the second inside the window, with
   * no Check by the owner in between, marks the account `auth_failed`.
   * Returns what the refusal did.
   */
  refused(orgId: string, credential: CredentialMetadata, revision: number): Promise<"waiting" | "marked" | "stale">
}

/**
 * One vendor 401 does not take an account off its provider; a second on the
 * same stored value inside the window, with no Check in between, is the
 * account having stopped working. The count lives in this isolate, so a
 * second refusal that lands elsewhere counts as a first there; the account is
 * then marked by the next one, or by the owner's own Check. Every path a
 * stored account is spent on — the plane's broker, a session host's Pi turn —
 * reports its refusals here, so the rule is one.
 */
export function createCredentialRefusals(input: { credentials: (orgId: string) => ControlPlaneCredentials; now?: () => number }): CredentialRefusals {
  const now = input.now ?? Date.now
  /** Consecutive vendor refusals per credential, in this isolate. */
  const refusals = new Map<string, { revision: number; count: number; at: number }>()
  return {
    async refused(orgId, credential, revision) {
      if (credential.revision !== revision) return "stale"
      const at = now()
      const key = `${orgId}\n${credential.id}`
      const seen = refusals.get(key)
      const checkedSince = credential.last_validated_at != null && seen !== undefined && credential.last_validated_at >= seen.at
      const runs = seen !== undefined && seen.revision === revision && at - seen.at < FAILURE_WINDOW_MS && !checkedSince
      const count = runs ? seen.count + 1 : 1
      if (count < FAILURES_BEFORE_YIELDING) {
        refusals.set(key, { revision, count, at })
        log.info("Vendor refused a stored credential once; waiting for a second before acting", { credential_id: credential.id, provider_id: credential.provider_id })
        return "waiting"
      }
      refusals.delete(key)
      await input.credentials(orgId).updateCredentialHealth?.(credential.id, "auth_failed", at)
      return "marked"
    },
  }
}
