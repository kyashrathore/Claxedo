import { authorizeDocument, DocumentAccessError, hashDocumentLink } from "@claxedo/account-contract/document-access"
import { Hono } from "hono"
import { requireDocumentAccess } from "@claxedo/server-core/documents/access"
import type { DocumentsBackend } from "@claxedo/server-core/documents/backend"
import { createDocumentsService } from "@claxedo/server-core/documents/service"

export function PublicDocumentRoutes(options: {
  backend: DocumentsBackend
  rateLimit: (key: string) => Promise<boolean>
}) {
  return new Hono().onError((error, context) => {
    if (error instanceof DocumentAccessError) return context.json({ error: { code: "document_not_found", message: "Document not found" } }, 404)
    throw error
  }).get("/:token", async (context) => {
    const key = context.req.header("cf-connecting-ip") ?? "unknown"
    if (!await options.rateLimit(`document-link:${key}`)) return context.json({ error: { code: "rate_limited" } }, 429)
    const token = context.req.param("token")
    const access = requireDocumentAccess(options.backend.access)
    const share = await access.shares.findLink(await hashDocumentLink(token))
    if (!share) throw new DocumentAccessError()
    const entry = await authorizeDocument({ token, access }, share.document_id, "view")
    const read = await createDocumentsService(options.backend).readPublicContent({ token, access }, entry.id)
    context.header("cache-control", "no-store")
    context.header("referrer-policy", "no-referrer")
    return context.json({ document: { id: entry.id, display_name: entry.display_name }, content: read })
  })
}
