import { readPluginManifest, type PluginDefinition } from "@claxedo/plugin-api"
import pages, { dictionary as pagesDictionary } from "@claxedo/plugin-pages"
import pagesPackage from "@claxedo/plugin-pages/package.json"
import tasks, { dictionary as tasksDictionary } from "@claxedo/plugin-tasks"
import tasksPackage from "@claxedo/plugin-tasks/package.json"
import type { Translations } from "@/i18n"
import type { PluginBuild } from "./model"

function bundled(packageJson: unknown, definition: PluginDefinition, dictionary?: Translations): PluginBuild {
  return { manifest: readPluginManifest(packageJson), origin: { kind: "bundled" }, definition, dictionary }
}

export function bundledPlugins(): readonly PluginBuild[] {
  return [
    bundled(tasksPackage, tasks, tasksDictionary),
    bundled(pagesPackage, pages, pagesDictionary),
  ]
}
