import { lazyView } from "@/lib/lazy-view"
import type { SettingsSection } from "@/shell"
import { useProjectsText } from "./i18n"
export { draftProjectName } from "./project-source"
export { primaryPlacement } from "./open"
export { inCatalogOrder } from "./project-order"
export { pickProjectFolderWith } from "./pick-project-folder"
export { ProjectListProvider, useProjectList } from "./project-list"
export type { Loaded } from "./store"
export { useProjects } from "./store"
export { projectSettingsPath } from "./routes"
export { createDraftPlacementResolver } from "./draft-context"
export { NewSessionContextRow } from "./view/new-session-context-row"
export type { WhereCreation, WhereNew } from "./draft-where"
export { loadProjectCreate, ProjectCreateForm } from "./view/project-create-lazy"
export { projectsDictionary } from "./i18n"

export const projectsSettingsSection: SettingsSection = {
  id: "projects",
  title: () => useProjectsText()("projects.title"),
  group: "workspace",
  order: 10,
  view: lazyView(() => import("./view/projects-settings").then((module) => module.ProjectsSettings)),
}
