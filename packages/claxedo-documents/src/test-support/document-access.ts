import type { DocumentAccess } from "../host/access"
import type { DocumentsBackend } from "../host/backend"

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
