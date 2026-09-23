import type { PluginModule } from "@claxedo/plugin-api"
import { codexThemePlugin } from "@claxedo/plugin-codex-theme"
import { compactTabsPlugin } from "@claxedo/plugin-compact-tabs"
import { pagesPlugin } from "@claxedo/plugin-pages"
import { tasksPlugin } from "@claxedo/plugin-tasks"

export const bundledPlugins: readonly PluginModule[] = [tasksPlugin, pagesPlugin, compactTabsPlugin, codexThemePlugin]
