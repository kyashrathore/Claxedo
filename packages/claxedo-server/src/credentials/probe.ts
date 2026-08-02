import { Log } from "../log"
import type { LocalCredentialItem } from "./sync"
import type { CredentialProbe } from "./discovery"
import { CredentialVerificationError, verifyCredential } from "./verify"
import type { CredentialMetadata } from "./types"

const log = Log.create({ service: "credentials-probe" })

/**
 * Probes a *discovered but unsaved* candidate against its provider.
 *
 * Discovery used to hand back whatever it read off disk, pre-selected, with no
 * claim about whether any of it worked — verification happened only after the
 * user committed. That inverted the cost: a credential saved and then found
 * broken is worse than one never offered, because the user believes setup
 * succeeded and only discovers otherwise mid-task.
 *
 * Cost note: this spends one real request per candidate per scan, and for a
 * ChatGPT subscription that request comes out of the user's own quota. Probes
 * are therefore run once per discovery and stashed with it, never on re-render.
 */
export async function probeDiscoveredCredential(
  item: LocalCredentialItem,
  options: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<CredentialProbe> {
  const credential = {
    id: `discovery:${item.provider_id}`,
    provider_id: item.provider_id,
    kind: item.kind,
    source: item.source,
    label: item.label,
    account_id: item.account_id ?? null,
    // A discovered item carries no saved expiry; `fresh_until` is what the
    // collector believes. Passing it lets a stale-but-refreshable Codex token
    // renew during the probe exactly as it would after saving.
    expires_at: item.fresh_until ?? null,
  } as unknown as CredentialMetadata

  try {
    const outcome = await verifyCredential(credential, item.secret, options)
    return verdict(outcome.health)
  } catch (error) {
    // `CredentialVerificationError` means we could not form a verdict — an
    // unsupported provider, an unreadable secret shape, or a failed request.
    // That is "can't tell", never "broken".
    if (error instanceof CredentialVerificationError) {
      log.info("probe inconclusive", { provider: item.provider_id, reason: error.message })
      return { state: "unknown", reason: inconclusiveCopy(error.message) }
    }
    throw error
  }
}

function verdict(health: string): CredentialProbe {
  // A quota-capped subscription authenticated: the provider answered us and
  // will again once the window rolls over. That is working, not broken.
  if (health === "ok") return { state: "working" }
  if (health === "rate_capped") return { state: "working" }
  if (health === "auth_failed") {
    return { state: "broken", reason: "The provider rejected this credential." }
  }
  if (health === "expired") {
    return { state: "broken", reason: "This credential has expired and couldn't be renewed." }
  }
  if (health === "no_billing") {
    return { state: "broken", reason: "The provider reports no active billing for this account." }
  }
  return { state: "unknown", reason: "The provider gave an answer we couldn't read." }
}

function inconclusiveCopy(message: string) {
  if (message.includes("does not support verification")) {
    return "Claxedo can't check this provider yet — it will be used as-is."
  }
  if (message.includes("unsupported shape")) {
    return "This credential isn't in a shape Claxedo can check."
  }
  return "Couldn't reach the provider to check this."
}
