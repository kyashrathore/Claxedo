import { definePlugin } from "@claxedo/plugin-api"
import type { DocumentsCardKey } from "./dictionary"
import { documentToolCards } from "./tool-cards"

export { dictionary } from "./dictionary"

export default definePlugin({
  activate: (api) => {
    api.transcript.toolCards(documentToolCards((key: DocumentsCardKey) => api.i18n.t(key)))
  },
})
