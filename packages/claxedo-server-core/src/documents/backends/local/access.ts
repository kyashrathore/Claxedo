import { DocumentAccessError } from "@claxedo/account-contract/document-access"
import type { DocumentAccess } from "@claxedo/server-core/documents/access"
import { createDocumentShareStore } from "@claxedo/server-core/documents/share-store"
import { findDocumentIndexEntry } from "@claxedo/server-core/documents/index-store"
import { ClaxedoDB, queryRows } from "@claxedo/server-core/platform/db/index"
import { localControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"

export function localDocumentAccess(): DocumentAccess {
  const local = localControlPlaneAuth()
  const member = async (userId: string, orgId: string) => userId === local.user.subject && orgId === "__local__"
  const access: DocumentAccess = {
    async principal(auth, orgId) {
      orgId ??= "__local__"
      if (auth.user.issuer !== local.user.issuer || !await member(auth.user.subject, orgId)) throw new DocumentAccessError()
      return { userId: auth.user.subject, orgId, access }
    },
    findDocument: async (orgId, id) => findDocumentIndexEntry(orgId, id),
    locateDocument: async (userId, id) => await member(userId, "__local__") ? findDocumentIndexEntry("__local__", id) : undefined,
    shares: createDocumentShareStore({
      all: async (sql, values) => queryRows(ClaxedoDB.raw(), sql, ...values),
      run: async (sql, values) => { ClaxedoDB.raw().prepare(sql).run(...values) },
    }),
    isOrgMember: member,
    isTeamMember: async () => false,
    isTeamInOrg: async () => false,
    hasProjectAccess: async (userId, orgId) => await member(userId, orgId),
  }
  return access
}
