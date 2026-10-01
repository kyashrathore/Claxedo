import { Hono } from "hono"
import { DocumentAccessError } from "@claxedo/server-core/documents/access"
import type { DocumentsBackend } from "@claxedo/server-core/documents/backend"
import { createDocumentsService } from "@claxedo/server-core/documents/service"

export function PublicDocumentRoutes(options: {
  backend: DocumentsBackend
  rateLimit: (key: string) => Promise<boolean>
}) {
  return new Hono()
    .onError((error, context) => {
      if (error instanceof DocumentAccessError) {
        return context.json({ error: { code: "document_not_found", message: "Document not found" } }, 404)
      }
      throw error
    })
    .get("/:token", async (context) => {
      const client = context.req.header("cf-connecting-ip") ?? "unknown"
      if (!(await options.rateLimit(`document-link:${client}`))) {
        return context.json({ error: { code: "rate_limited" } }, 429)
      }
      const { entry, read } = await createDocumentsService(options.backend).readLinkedContent(
        context.req.param("token"),
      )
      context.header("cache-control", "no-store")
      context.header("referrer-policy", "no-referrer")
      return context.json({ document: { id: entry.id, display_name: entry.display_name }, content: read })
    })
}
