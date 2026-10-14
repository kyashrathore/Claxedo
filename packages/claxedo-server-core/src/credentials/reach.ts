import type { SandboxSecretBrokering } from "@claxedo/sandbox-contract"
import { builtInProviderDestinationShape } from "./built-in-destinations"
import { isSubscriptionKind } from "./secret-material"
import type { CredentialKind } from "./types"

/**
 * How a harness inside a workspace's sandbox is kept from reading the account
 * it spends. The driver's own `secretBrokering` is two of the answers; the
 * third is the control plane's own egress broker standing in for a driver
 * that has no provider edge, so the sandbox holds a placeholder and the plane
 * holds the value.
 */
export type HarnessSecretDelivery = SandboxSecretBrokering | "hosted-broker"

/**
 * The delivery a workspace's harness gets, from the driver's fact and whether
 * the plane serving the workspace brokers. A driver with its own edge keeps
 * it: the broker never enters a native driver's request path.
 */
export function harnessSecretDelivery(driver: SandboxSecretBrokering, hostedBroker: boolean): HarnessSecretDelivery {
  return driver === "native" ? "native" : hostedBroker ? "hosted-broker" : "none"
}

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
   * account on the driver new workspaces get. Asked only where that delivery
   * is known; a driver that cannot broker on a plane that does not either
   * leaves the account to Pi, which calls the vendor from outside the sandbox.
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

/**
 * Whether the hosted broker can stand in for a destination. One that exchanges
 * the stored key for a session token cannot be served from a Worker: the
 * exchanged token lives in the broker's memory, and the next request can land
 * on an isolate that never saw the exchange.
 */
export function hostedBrokerServes(destination: { exchange?: unknown }): boolean {
  return destination.exchange === undefined
}

export function credentialReach(row: { provider_id: string; kind: CredentialKind }, delivery?: HarnessSecretDelivery): CredentialReach {
  const destination = builtInProviderDestinationShape({ providerId: row.provider_id, kind: row.kind })
  if (!destination) return { local: true, cloud: false, reason: "no_destination" }
  if (destination.injection.headers && !deliveredDirect(row)) {
    return { local: true, cloud: false, reason: "native_delivery_needs_companion_header" }
  }
  if (!delivery) return { local: true, cloud: true }
  const cloudHarness = delivery === "native" || deliveredDirect(row) || (delivery === "hosted-broker" && hostedBrokerServes(destination))
  return { local: true, cloud: true, cloudHarness }
}
