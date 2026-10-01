import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { DocumentIndexEntry } from "@claxedo/server-core/documents/index-contract"

export type DocumentAction = "view" | "edit" | "manage"

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

export type NewDocumentShare = Pick<DocumentShare, "id" | "target" | "target_id" | "level">

/**
 * `page` is the entry the principal was authorized against. A page's
 * organization, project and creator are fixed when it is indexed, so they
 * cannot have moved since that read; everything else a share write depends on
 * is asked again by the write itself.
 */
export type DocumentSharing = Readonly<{
  list(documentId: string): Promise<DocumentShare[]>
  /**
   * Refuses unless, at the write, the principal still manages `page` (404)
   * and a person or team target still stands in its organization (400).
   */
  create(principal: DocumentPrincipal, page: DocumentIndexEntry, share: NewDocumentShare): Promise<DocumentShare>
  /** Refuses (404) unless, at the write, the principal still manages `page`. */
  revoke(principal: DocumentPrincipal, page: DocumentIndexEntry, shareId: string): Promise<void>
  findLink(hash: string): Promise<DocumentShare | undefined>
  /** The unrevoked person and team shares in `orgId` that reach `userId`. */
  granted(userId: string, orgId: string): Promise<readonly DocumentShare[]>
}>

export type DocumentAccess = Readonly<{
  principal(auth: SignedControlPlaneAuth, orgId?: string): Promise<DocumentPrincipal>
  findDocument(orgId: string, documentId: string): Promise<DocumentIndexEntry | undefined>
  locateDocument(userId: string, documentId: string): Promise<DocumentIndexEntry | undefined>
  isOrgMember(userId: string, orgId: string): Promise<boolean>
  hasProjectAccess(userId: string, orgId: string, projectId: string): Promise<boolean>
  /** Absent where documents cannot be shared: every page there is its creator's alone. */
  sharing?: DocumentSharing
}>

/** `actorId` is the acting actor where the store tracks actors; a share write requires it still active. */
export type DocumentPrincipal = Readonly<{ userId: string; actorId?: string; orgId?: string; access: DocumentAccess }>

export class DocumentAccessError extends Error {
  constructor(
    readonly code = "document_not_found",
    readonly status = 404,
  ) {
    super(status === 404 ? "Document not found" : code)
  }
}

export async function authorizeDocument(principal: DocumentPrincipal, documentId: string, action: DocumentAction) {
  const entry = principal.orgId
    ? await principal.access.findDocument(principal.orgId, documentId)
    : await principal.access.locateDocument(principal.userId, documentId)
  const [allowed] = entry ? await permittedDocuments(principal, [entry], action) : []
  if (!allowed) throw new DocumentAccessError()
  return allowed
}

/** A link reads its page only while the page's creator could still read it themselves. */
export async function authorizeDocumentLink(access: DocumentAccess, token: string) {
  const share = await access.sharing?.findLink(await hashDocumentLink(token))
  if (!share || share.target !== "link" || share.level !== "view" || share.revoked_at !== null) {
    throw new DocumentAccessError()
  }
  const entry = await access.findDocument(share.org_id, share.document_id)
  if (!entry?.creator_id || entry.archived_at) throw new DocumentAccessError()
  const [readable] = await permittedDocuments(
    { userId: entry.creator_id, orgId: entry.org_id, access },
    [entry],
    "view",
  )
  if (!readable) throw new DocumentAccessError()
  return readable
}

/**
 * Membership, project access and shares are read once per organization and
 * project, not once per entry: a Worker invocation may issue at most 1,000 D1
 * queries, and a listing can hold more entries than that.
 */
export async function filterDocuments(principal: DocumentPrincipal, entries: readonly DocumentIndexEntry[]) {
  return await permittedDocuments(principal, entries, "view")
}

async function permittedDocuments(
  principal: DocumentPrincipal,
  entries: readonly DocumentIndexEntry[],
  action: DocumentAction,
) {
  const { access, userId } = principal
  const gates = new Map<string, Promise<boolean>>()
  const grants = new Map<string, Promise<readonly DocumentShare[]>>()
  const passesGate = (entry: DocumentIndexEntry) =>
    loadOnce(
      gates,
      `${entry.org_id}\n${entry.project_id}`,
      async () =>
        (await access.isOrgMember(userId, entry.org_id)) &&
        (await access.hasProjectAccess(userId, entry.org_id, entry.project_id)),
    )
  const granted = (orgId: string) =>
    loadOnce(grants, orgId, async () => (await access.sharing?.granted(userId, orgId)) ?? [])
  const permitted: DocumentIndexEntry[] = []
  for (const entry of entries) {
    if (!entry.creator_id || (principal.orgId && entry.org_id !== principal.orgId)) continue
    if (!(await passesGate(entry))) continue
    if (entry.creator_id === userId) {
      permitted.push(entry)
      continue
    }
    if (action === "manage") continue
    const shares = await granted(entry.org_id)
    if (shares.some((share) => share.document_id === entry.id && (action === "view" || share.level === "edit"))) {
      permitted.push(entry)
    }
  }
  return permitted
}

function loadOnce<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>) {
  const cached = cache.get(key)
  if (cached) return cached
  const loaded = load()
  cache.set(key, loaded)
  return loaded
}

export function requireDocumentSharing(access: DocumentAccess) {
  if (!access.sharing) throw new DocumentAccessError("document_sharing_unavailable", 501)
  return access.sharing
}

export async function createDocumentShare(
  principal: DocumentPrincipal,
  page: DocumentIndexEntry,
  input: Readonly<{ target: "person" | "team" | "link"; target_id?: string; level: "view" | "edit" }>,
) {
  const sharing = requireDocumentSharing(principal.access)
  let token: string | undefined
  let targetId = input.target_id
  if (input.target === "link") {
    if (input.level !== "view" || targetId) throw new DocumentAccessError("document_link_view_only", 400)
    token = hex(crypto.getRandomValues(new Uint8Array(32)))
    targetId = await hashDocumentLink(token)
  } else if (!targetId) {
    throw new DocumentAccessError("document_share_target_outside_organization", 400)
  }
  const share = await sharing.create(principal, page, {
    id: `document_share_${crypto.randomUUID().replaceAll("-", "")}`,
    target: input.target,
    target_id: targetId,
    level: input.level,
  })
  return { ...share, ...(token ? { token } : {}) }
}

async function hashDocumentLink(token: string) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))))
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}
