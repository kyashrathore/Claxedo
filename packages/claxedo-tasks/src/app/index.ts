import { definePlugin } from "@claxedo/plugin-api"
import { taskToolCards } from "./tool-cards"

export { dictionary } from "./dictionary"

export default definePlugin({
  activate: (api) => {
    api.transcript.toolCards(taskToolCards((key) => api.i18n.t(key)))
  },
})
