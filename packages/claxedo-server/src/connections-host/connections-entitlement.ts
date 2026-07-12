/**
 * F5 (adversarial-review): compose the hosted-connections entitlement hook that
 * `connections-host.ts` consults after D7 org resolution. The gate itself has
 * existed but was dead code — the production `createConnectionsHost` call never
 * supplied the hook, so flipping `CLAXEDO_HOSTED_CREDENTIALS_ENABLED` would have
 * served paid connections to free orgs. This builder is the missing wiring.
 *
 * It lives OUTSIDE server.ts on purpose: server.ts is a self-host entrypoint
 * that the architecture guard (billing-architecture.test.ts) keeps Polar-/
 * billing-free (invariant I-1). server.ts imports THIS module (no "billing/"
 * substring, no Polar), and this module — never in the CF Worker bundle nor a
 * self-host entrypoint — is free to reach into src/billing/entitlement.ts.
 *
 * Self-host returns `undefined` (no hook at all): the gate is only consulted in
 * hosted mode inside connections-host.ts regardless, and we additionally refuse
 * to construct the billing store on the self-host path — byte-identical, never
 * gated. The org key is the caller's Clerk `org_id` claim (D7 `org:{orgId}`),
 * so the entitlement ref is `{ clerkOrgId }`.
 */
import { createEntitlementGate } from "../billing/entitlement"
import type { BillingStore } from "../billing/billing-store"
import { deploymentMode } from "../control-plane/deployment-mode"
import type { ConnectionsHostOptions } from "./connections-host"

export function hostedConnectionsEntitlement(
  env: Record<string, string | undefined>,
  options: { store?: BillingStore; now?: () => number } = {},
): ConnectionsHostOptions["requireHostedConnectionsEntitlement"] {
  if (deploymentMode(env) !== "hosted") return undefined
  const gate = createEntitlementGate({
    env,
    ...(options.store ? { store: options.store } : {}),
    ...(options.now ? { now: options.now } : {}),
  })
  return (clerkOrgId: string) => gate({ clerkOrgId }, "hosted-connections")
}
