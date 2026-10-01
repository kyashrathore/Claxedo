import type { DocumentAccess } from "@claxedo/server-core/documents/access"
import type { DocumentsBackend } from "@claxedo/server-core/documents/backend"

export function documentTestAccess(index: DocumentsBackend["index"], organizations: readonly string[] = ["org_1", "org_tenant_a", "__local__"]): DocumentAccess {
  const access: DocumentAccess = {
    principal: async (auth, orgId) => ({ userId: auth.user.subject, orgId, access }),
    findDocument: async (orgId, id) => await index.find(orgId, id),
    async locateDocument(_userId, id) {
      for (const orgId of organizations) {
        const entry = await index.find(orgId, id)
        if (entry) return entry
      }
      return undefined
    },
    shares: { list: async () => [], create: async (share) => share, revoke: async () => {}, findLink: async () => undefined },
    isOrgMember: async () => true,
    isTeamMember: async () => false,
    isTeamInOrg: async () => false,
    hasProjectAccess: async () => true,
  }
  return access
}
