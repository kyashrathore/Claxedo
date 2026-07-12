/**
 * F12 (adversarial review): compose the org-membership verifier that
 * `connections-host.ts` consults after D7 org resolution. The hosted team
 * partition (`org:{orgId}`) is keyed on the caller's verified Clerk `org_id`
 * claim; D2 forbids a JWT org claim being the SOLE authorization input, so the
 * host re-checks the subject is a real Convex member of that org before
 * granting the team partition.
 *
 * Convex-only, service-token gated (the host is a machine principal for this
 * check — it holds no end-user Convex identity on the connections turn). Reuses
 * the same fetch-based `ConvexHttpClient` calling convention as billing-store —
 * Worker-safe, no node:* imports — but this module is imported only by the Node
 * connections entrypoint (server.ts), never the CF Worker bundle.
 *
 * Self-host returns `undefined` (no verifier): the connections-host gate only
 * consults it in hosted mode regardless, and we additionally refuse to build a
 * Convex client on the self-host path — byte-identical, never checked. The
 * verifier deliberately does NOT swallow errors: a Convex outage propagates so
 * the gate fails closed (a membership it cannot confirm is not granted).
 */
import { ConvexHttpClient } from "convex/browser"
import { anyApi, type FunctionReference } from "convex/server"
import { deploymentMode } from "../control-plane/deployment-mode"
import type { ConnectionsHostOptions } from "./connections-host"

type OrgsApi = {
  orgs: {
    membershipByClerkIds: FunctionReference<"query">
  }
}

const orgsApi = anyApi as unknown as OrgsApi

function clean(value?: string) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function hostedOrgMembershipVerifier(
  env: Record<string, string | undefined>,
  options: { verify?: ConnectionsHostOptions["verifyOrgMembership"] } = {},
): ConnectionsHostOptions["verifyOrgMembership"] {
  if (deploymentMode(env) !== "hosted") return undefined
  if (options.verify) return options.verify

  const url = clean(env.CLAXEDO_WORKSPACE_AUTHORITY_URL)
  const serviceToken = clean(env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN)

  return async ({ subject, orgId }) => {
    // Missing config = we cannot confirm membership → fail closed (deny),
    // never grant a team partition on an unconfirmable claim.
    if (!url || !serviceToken) return false
    const result = (await new ConvexHttpClient(url).query(orgsApi.orgs.membershipByClerkIds as never, {
      service_token: serviceToken,
      clerk_org_id: orgId,
      clerk_subject: subject,
    } as never)) as { member: boolean } | null
    return !!result?.member
  }
}
