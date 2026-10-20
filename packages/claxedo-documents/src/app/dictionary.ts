const en = {
  "claxedo-documents.card.documents_list": "List documents",
  "claxedo-documents.card.documents_open": "Open document",
  "claxedo-documents.card.document.one": "document",
  "claxedo-documents.card.document.other": "documents",
  "claxedo-documents.card.fact.path": "Path",
  "claxedo-documents.card.fact.session": "Session",
}

export type DocumentsCardKey = keyof typeof en

export const dictionary: { readonly en: Readonly<Record<DocumentsCardKey, string>> } = { en }
