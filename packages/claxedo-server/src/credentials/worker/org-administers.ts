import type { D1Database } from "@cloudflare/workers-types"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { may } from "../../authority/adapters/d1/authorization"

export type OrgAdministers = (auth: SignedControlPlaneAuth, orgId: string) => Promise<boolean>

/**
 * Whether the signed caller is an owner or admin of the organization, by the
 * D1 authority's own rule. The signed subject is the application user id, the
 * same person the credential routes stamp on the rows they write.
 */
export function hostedOrgAdministers(database: D1Database): OrgAdministers {
  return async (auth, orgId) => await may(database, { userId: auth.user.subject }, "administer", { kind: "org", orgId })
}
