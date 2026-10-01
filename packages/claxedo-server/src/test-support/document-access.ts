import type { DocumentAccess } from "@claxedo/server-core/documents/access"
import type { DocumentsBackend } from "@claxedo/server-core/documents/backend"
import { fetchUrl } from "./fetch-calls"

/**
 * Every caller is a member with project access in each of `organizations` and
 * nothing is shared, unless `overrides` says otherwise.
 */
export function documentTestAccess(
  index: Pick<DocumentsBackend["index"], "find">,
  organizations: readonly string[] = ["org_1", "org_tenant_a", "__local__"],
  overrides: Partial<Omit<DocumentAccess, "principal">> = {},
): DocumentAccess {
  const access: DocumentAccess = {
    principal: async (auth, orgId) => ({ userId: auth.user.subject, ...(orgId ? { orgId } : {}), access }),
    findDocument: async (orgId, id) => await index.find(orgId, id),
    async locateDocument(_userId, id) {
      for (const orgId of organizations) {
        const entry = await index.find(orgId, id)
        if (entry) return entry
      }
      return undefined
    },
    isOrgMember: async () => true,
    hasProjectAccess: async () => true,
    ...overrides,
  }
  return access
}

/** The control plane's answer to a runtime asking whether the job's person may still edit the page. */
export function documentAuthorizedFetch(handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  return (async (input: string | URL | Request, init?: RequestInit) =>
    new URL(fetchUrl(input)).pathname.endsWith("/runtime-authorization")
      ? new Response(null, { status: 204 })
      : await handler(input, init)) as typeof fetch
}
