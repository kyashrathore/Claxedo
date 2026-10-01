export type DocumentAction = "view" | "edit" | "share"
export type DocumentAccessEntry = { id: string; org_id: string; project_id: string; creator_id?: string | null; archived_at: string | null }
export type DocumentShare = Readonly<{
  id: string
  document_id: string
  org_id: string
  target: "person" | "team" | "link"
  target_id: string
  level: "view" | "edit"
  created_by: string
  revoked_at: number | null
}>

export type DocumentShareStore = {
  list(documentId: string): Promise<DocumentShare[]>
  create(share: DocumentShare): Promise<DocumentShare>
  revoke(documentId: string, shareId: string): Promise<void>
  findLink(hash: string): Promise<DocumentShare | undefined>
}

export type DocumentAuthorizationAccess<T extends DocumentAccessEntry> = {
  findDocument(orgId: string, documentId: string): Promise<T | undefined>
  locateDocument(userId: string, documentId: string): Promise<T | undefined>
  shares: DocumentShareStore
  isOrgMember(userId: string, orgId: string): Promise<boolean>
  isTeamMember(userId: string, teamId: string, orgId: string): Promise<boolean>
  hasProjectAccess(userId: string, orgId: string, projectId: string): Promise<boolean>
}
export type LocalDocumentPrincipal<T extends DocumentAccessEntry> =
  { userId: string; orgId?: string; access: DocumentAuthorizationAccess<T> } |
  { token: string; access: DocumentAuthorizationAccess<T> }
export type RemoteDocumentPrincipal = { requestAuthorization(documentId: string, action: DocumentAction): Promise<Response> }
export class DocumentAccessError extends Error {
  constructor(readonly code = "document_not_found", readonly status = 404) {
    super(status === 404 ? "Document not found" : code)
  }
}

export function authorizeDocument<T extends DocumentAccessEntry>(principal: LocalDocumentPrincipal<T>, documentId: string, action: DocumentAction): Promise<T>
export function authorizeDocument(principal: RemoteDocumentPrincipal, documentId: string, action: DocumentAction): Promise<void>
export async function authorizeDocument<T extends DocumentAccessEntry>(principal: LocalDocumentPrincipal<T> | RemoteDocumentPrincipal, documentId: string, action: DocumentAction): Promise<T | void> {
  if ("requestAuthorization" in principal) {
    const response = await principal.requestAuthorization(documentId, action)
    if (!response.ok) throw new DocumentAccessError()
    return
  }
  return await authorizeLocalDocument(principal, documentId, action)
}

async function authorizeLocalDocument<T extends DocumentAccessEntry>(principal: LocalDocumentPrincipal<T>, documentId: string, action: DocumentAction) {
  const { access } = principal
  if ("token" in principal) {
    if (action !== "view") throw new DocumentAccessError()
    const share = await access.shares.findLink(await hashDocumentLink(principal.token))
    if (!share || share.document_id !== documentId || share.target !== "link" || share.level !== "view" || share.revoked_at !== null) throw new DocumentAccessError()
    const entry = await access.findDocument(share.org_id, documentId)
    if (!entry?.creator_id || entry.archived_at ||
      !await access.isOrgMember(entry.creator_id, entry.org_id) ||
      !await access.hasProjectAccess(entry.creator_id, entry.org_id, entry.project_id)) throw new DocumentAccessError()
    return entry
  }
  const entry = principal.orgId ? await access.findDocument(principal.orgId, documentId) : await access.locateDocument(principal.userId, documentId)
  if (!entry?.creator_id || (principal.orgId && entry.org_id !== principal.orgId) ||
    !await access.isOrgMember(principal.userId, entry.org_id) ||
    !await access.hasProjectAccess(principal.userId, entry.org_id, entry.project_id)) throw new DocumentAccessError()
  if (entry.creator_id === principal.userId) return entry
  if (action === "share") throw new DocumentAccessError()
  for (const share of await access.shares.list(documentId)) {
    if (share.revoked_at !== null || share.org_id !== entry.org_id || (action === "edit" && share.level !== "edit")) continue
    if (share.target === "person" && share.target_id === principal.userId) return entry
    if (share.target === "team" && await access.isTeamMember(principal.userId, share.target_id, entry.org_id)) return entry
  }
  throw new DocumentAccessError()
}

export async function hashDocumentLink(token: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))),
    (byte) => byte.toString(16).padStart(2, "0")).join("")
}

