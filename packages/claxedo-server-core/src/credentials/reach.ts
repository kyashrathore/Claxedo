import type { SandboxSecretBrokering } from "@claxedo/sandbox-contract"
import { builtInProviderDestinationShape } from "./built-in-destinations"
import { isSubscriptionKind } from "./secret-material"
import type { CredentialKind } from "./types"

/**
 * Where an account can actually be spent.
 *
 * `local` is always true: the loopback broker holds the value in this process
 * and every stored account reaches it. `cloud` is the narrower question, and it
 * is answered here rather than inferred from "we have it stored", because a
 * provider edge attaches one header per secret and a destination that also
 * needs a fixed companion header cannot be delivered through one at all.
 *
 * Asked of the row's shape with no secret: an operator-declared provider is
 * reached only where its org's declarations are read, which is delivery, not
 * this list.
 */
export type CredentialReach = {
  local: true
  cloud: boolean
  reason?: string
  /**
   * Whether a harness running inside a cloud workspace can be handed the
   * account on the driver new workspaces get. Asked only where that driver is
   * known; a driver that cannot broker leaves the account to Pi, which calls
   * the vendor from outside the sandbox.
   */
  cloudHarness?: boolean
}

/**
 * The plan logins a cloud runtime is handed as the access token itself. Codex
 * signs in with a ChatGPT plan's tokens (`chatgptAuthTokens`), and OpenCode's
 * plan path and Pi read the account from the token, so each sends the plan's
 * account header on its own and no edge has to; the refresh token stays with
 * the credential store.
 */
const DIRECT_PLAN_PROVIDERS: ReadonlySet<string> = new Set(["codex-app-server"])

export function deliveredDirect(row: { provider_id: string; kind: CredentialKind }): boolean {
  return isSubscriptionKind(row.kind) && DIRECT_PLAN_PROVIDERS.has(row.provider_id)
}

export function credentialReach(row: { provider_id: string; kind: CredentialKind }, brokering?: SandboxSecretBrokering): CredentialReach {
  const destination = builtInProviderDestinationShape({ providerId: row.provider_id, kind: row.kind })
  if (!destination) return { local: true, cloud: false, reason: "no_destination" }
  if (destination.injection.headers && !deliveredDirect(row)) {
    return { local: true, cloud: false, reason: "native_delivery_needs_companion_header" }
  }
  return { local: true, cloud: true, ...(brokering ? { cloudHarness: brokering === "native" || deliveredDirect(row) } : {}) }
}
