import { DocumentAccessError, type DocumentAccess } from "@claxedo/server-core/documents/access"
import { findDocumentIndexEntry } from "@claxedo/server-core/documents/index-store"
import { localControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"

const LOCAL_ORG = "__local__"

/**
 * The machine's own person is the only principal: this store knows no
 * organizations or teams, so a signed caller cannot be authorized and nothing
 * can be shared.
 */
export function localDocumentAccess(): DocumentAccess {
  const local = localControlPlaneAuth().user
  const isLocal = async (userId: string, orgId: string) => userId === local.subject && orgId === LOCAL_ORG
  const access: DocumentAccess = {
    async principal(auth, orgId = LOCAL_ORG) {
      if (auth.user.issuer !== local.issuer) {
        throw new DocumentAccessError("document_signed_access_unavailable", 501)
      }
      if (!(await isLocal(auth.user.subject, orgId))) throw new DocumentAccessError()
      return { userId: auth.user.subject, orgId, access }
    },
    findDocument: async (orgId, id) => findDocumentIndexEntry(orgId, id),
    locateDocument: async (userId, id) =>
      (await isLocal(userId, LOCAL_ORG)) ? findDocumentIndexEntry(LOCAL_ORG, id) : undefined,
    isOrgMember: isLocal,
    hasProjectAccess: async (userId, orgId) => await isLocal(userId, orgId),
  }
  return access
}
