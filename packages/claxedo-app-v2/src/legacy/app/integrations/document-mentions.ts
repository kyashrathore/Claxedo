import { documentsApi, type DocumentsApi } from "@/features/documents/data/documents-api"

export type DocumentMentionOption = {
  documentId: string
  displayName: string
  originKind: "managed" | "repository"
  placementKind: "local" | "hosted"
  status: string
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

export function documentMentionText(document: Pick<DocumentMentionOption, "documentId">) {
  return `claxedo://document/${encodeURIComponent(document.documentId)}`
}
