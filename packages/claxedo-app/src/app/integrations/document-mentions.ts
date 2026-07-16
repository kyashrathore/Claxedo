import { documentsApi, type DocumentsApi } from "@/features/documents/data/documents-api"

export type DocumentMentionOption = {
  documentId: string
  displayName: string
  originKind: "managed" | "repository"
  placementKind: "local" | "hosted"
  status: string
}

export type ResolvedDocumentMention = {
  documentId: string
  displayName: string
  path: string
}

export async function listDocumentMentions(
  input: { projectId?: string; directory?: string },
  api: Pick<DocumentsApi, "list"> = documentsApi,
) {
  return (await api.list(input)).map(
    (document): DocumentMentionOption => ({
      documentId: document.id,
      displayName: document.display_name,
      originKind: document.origin_kind,
      placementKind: document.placement_kind,
      status: document.status,
    }),
  )
}

export async function openDocumentMention(
  input: {
    documentId: string
    sessionId: string
  },
  api: Pick<DocumentsApi, "agentOpen"> = documentsApi,
): Promise<ResolvedDocumentMention> {
  const opened = await api.agentOpen(input.documentId, input.sessionId)
  return {
    documentId: opened.document_id,
    displayName: opened.display_name,
    path: opened.path,
  }
}

export function documentMentionText(mention: ResolvedDocumentMention) {
  return `document: ${mention.displayName} at ${mention.path} (document_id: ${mention.documentId})`
}
