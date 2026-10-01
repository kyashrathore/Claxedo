import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { DocumentIndexEntry } from "@claxedo/server-core/documents/index-contract"

import { authorizeDocument, DocumentAccessError, hashDocumentLink, type DocumentAuthorizationAccess, type DocumentShareStore } from "@claxedo/account-contract/document-access"

export type DocumentPrincipal = { userId: string; orgId?: string; access: DocumentAccess } | { token: string; access: DocumentAccess }
export type DocumentAccess = DocumentAuthorizationAccess<DocumentIndexEntry> & {
  principal(auth: SignedControlPlaneAuth, orgId?: string): Promise<DocumentPrincipal>
  isTeamInOrg(teamId: string, orgId: string): Promise<boolean>
}

export async function filterDocuments(principal: DocumentPrincipal, entries: readonly DocumentIndexEntry[]) {
  const visible: DocumentIndexEntry[] = []
  for (const entry of entries) {
    try {
      await authorizeDocument(principal, entry.id, "view")
      visible.push(entry)
    } catch (error) {
      if (!(error instanceof DocumentAccessError)) throw error
    }
  }
  return visible
}

export async function createDocumentShare(principal: DocumentPrincipal, documentId: string, input: {
  target: "person" | "team" | "link"; target_id?: string; level: "view" | "edit"
}) {
  const entry = await authorizeDocument(principal, documentId, "share")
  if (!("userId" in principal)) throw new DocumentAccessError()
  const { access } = principal
  let token: string | undefined
  let targetId = input.target_id
  if (input.target === "link") {
    if (input.level !== "view" || targetId) throw new DocumentAccessError("document_link_view_only", 400)
    token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("")
    targetId = await hashDocumentLink(token)
  } else if (!targetId || !(input.target === "person"
    ? await access.isOrgMember(targetId, entry.org_id)
    : await access.isTeamInOrg(targetId, entry.org_id))) {
    throw new DocumentAccessError("document_share_target_outside_organization", 400)
  }
  const share = await access.shares.create({
    id: `document_share_${crypto.randomUUID().replaceAll("-", "")}`,
    document_id: documentId,
    org_id: entry.org_id,
    target: input.target,
    target_id: targetId,
    level: input.level,
    created_by: principal.userId,
    revoked_at: null,
  })
  return { ...share, ...(token ? { token } : {}) }
}

export function requireDocumentAccess(access: DocumentAccess | undefined) {
  if (!access) throw new DocumentAccessError()
  return access
}
