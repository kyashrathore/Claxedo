import { definePlugin, readPackageManifest, type PluginApi } from "@claxedo/plugin-api"
import pkg from "../package.json"

export const codexThemePlugin = definePlugin({
  manifest: readPackageManifest(pkg),
  activate: (api: PluginApi) => {
    api.i18n.add({ en: { title: "Codex theme" } })
  },
})
