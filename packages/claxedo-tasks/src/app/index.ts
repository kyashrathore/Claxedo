import { definePlugin, type PluginApi } from "@claxedo/plugin-api"
import { translator } from "./dictionary"
import { openPresetsSettings, pluginCatalogReader } from "./presets/program"
import { newRequestId } from "./request-id"
import { tasksClientOf } from "./tasks-client"
import { taskToolCards } from "./tool-cards"

export { dictionary } from "./dictionary"

export const PRESETS_SECTION_ID = "presets"

function registerPresets(api: PluginApi) {
  const t = translator(api.i18n)
  const deps = { client: tasksClientOf(api.server), t, ui: api.ui, catalog: pluginCatalogReader(api), requestId: newRequestId, now: () => Date.now() }
  return api.settings.section({
    id: PRESETS_SECTION_ID,
    title: t("claxedo-tasks.preset.sectionTitle"),
    group: "workspace",
    order: 30,
    surface: (channel) => openPresetsSettings(deps, channel),
  })
}

export default definePlugin({
  activate: (api) => {
    api.transcript.toolCards(taskToolCards((key) => api.i18n.t(key)))
    registerPresets(api)
  },
})
