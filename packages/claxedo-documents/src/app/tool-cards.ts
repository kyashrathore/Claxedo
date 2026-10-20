import type { ToolCardTemplate } from "@claxedo/plugin-api"
import type { DocumentsCardKey } from "./dictionary"

export type CardTranslate = (key: DocumentsCardKey) => string

/** The transcript cards for the two `documents_*` tools; the count and the facts appear once the tool has answered. */
export function documentToolCards(t: CardTranslate): readonly ToolCardTemplate[] {
  return [
    {
      tool: "documents_list",
      title: t("claxedo-documents.card.documents_list"),
      subject: {
        count: { path: "/result/documents", one: t("claxedo-documents.card.document.one"), other: t("claxedo-documents.card.document.other") },
      },
    },
    {
      tool: "documents_open",
      title: t("claxedo-documents.card.documents_open"),
      subject: { first: [{ path: "/result/name" }, { path: "/args/document" }] },
      facts: [
        { label: t("claxedo-documents.card.fact.path"), value: { path: "/result/path" }, mono: true },
        { label: t("claxedo-documents.card.fact.session"), value: { kind: "session", sessionId: { path: "/result/session" } } },
      ],
    },
  ]
}
