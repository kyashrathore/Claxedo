import { createEffect, on } from "solid-js"
import { definePlugin, type PluginApi } from "@claxedo/plugin-api"
import { translator, type Translate } from "./dictionary"
import type { PageDeps } from "./page/page-model"
import { openTasksPage } from "./page/program"
import { openPresetsSettings, pluginCatalogReader } from "./presets/program"
import { newRequestId } from "./request-id"
import { tasksClientOf } from "./tasks-client"
import { TASKS_PAGE_ID, taskToolCards } from "./tool-cards"

export { dictionary } from "./dictionary"

export const PRESETS_SECTION_ID = "presets"
export const TASKS_PAGE_PATH = "/tasks/:taskId?"

function projectsSignature(api: PluginApi): string {
  return [api.projects.currentId() ?? "", ...api.projects.list().map((project) => `${project.id}:${project.name}`)].join("\n")
}

function pageDeps(api: PluginApi, t: Translate): PageDeps {
  return {
    client: tasksClientOf(api.server),
    t,
    ui: api.ui,
    openPage: (params) => api.pages.open(TASKS_PAGE_ID, params),
    openPresets: () => api.settings.open(PRESETS_SECTION_ID),
    openSession: (session) => api.sessions.open(session),
    followStart: (workspaceId, onProgress) => api.workspaces.followStart(workspaceId, onProgress),
    projects: () => api.projects.list(),
    currentProjectId: () => api.projects.currentId(),
    watchProjects: (changed) => createEffect(on(() => projectsSignature(api), changed, { defer: true })),
    requestId: newRequestId,
    now: () => Date.now(),
  }
}

function registerTasksPage(api: PluginApi, t: Translate) {
  api.pages.register({ id: TASKS_PAGE_ID, path: TASKS_PAGE_PATH, title: t("claxedo-tasks.page.title"), tab: true, icon: "checklist", surface: (channel, props) => openTasksPage(pageDeps(api, t), channel, props) })
  api.sidebar.item({ id: TASKS_PAGE_ID, label: t("claxedo-tasks.page.title"), pageId: TASKS_PAGE_ID, icon: "checklist" })
}

function registerPresets(api: PluginApi, t: Translate) {
  const deps = { client: tasksClientOf(api.server), t, ui: api.ui, catalog: pluginCatalogReader(api), requestId: newRequestId, now: () => Date.now() }
  api.settings.section({ id: PRESETS_SECTION_ID, title: t("claxedo-tasks.preset.sectionTitle"), group: "workspace", order: 30, surface: (channel) => openPresetsSettings(deps, channel) })
}

export default definePlugin({
  activate: (api) => {
    const t = translator(api.i18n)
    api.transcript.toolCards(taskToolCards((key) => api.i18n.t(key)))
    registerTasksPage(api, t)
    registerPresets(api, t)
  },
})
