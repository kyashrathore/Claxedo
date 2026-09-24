import type { PageEntry } from "@/shell"
import { useProjectsText } from "./i18n"
import { addProjectPath } from "./routes"
import { AddProjectPage } from "./view/add-project-page"

export type { AddProjectFlow, ProjectCreated } from "./add-project"
export { createAddProjectFlow, useAddProjectFlow } from "./add-project"
export type { ProjectsKey, ProjectsText } from "./i18n"
export { dictionary as projectsDictionary, useProjectsText } from "./i18n"
export type { AddProjectEvent, AddProjectState, AddProjectStep, PlacementChoice, ProjectDraft } from "./model"
export { addProjectStep, addProjectSteps, addProjectTransition, draftProjectName, sourceLabel } from "./model"
export { useCreatedProjectOpener, usePlacementOpener } from "./open"
export { addProjectPath, projectSettingsPath } from "./routes"
export type { LocalProject, ProjectList } from "./project-list"
export { AVATAR_COLOR_KEYS, createProjectList, ProjectListProvider, useProjectList } from "./project-list"
export { validProjectRef, validWorktree } from "./project-state"
export type { Loaded, ProjectView } from "./store"
export { useEngineProjects, useMachines, useProject, useProjectCommands, useProjectPlacements, useProjects } from "./store"
export { AddProjectSteps } from "./view/add-project-steps"
export { placementKindLabel, PlacementList } from "./view/placement-list"
export { DialogEditProject, type EditableProject } from "./view/edit-project-dialog"
export { projectsSettingsSection } from "./view/projects-settings"

export const addProjectPage: PageEntry = {
  id: "add-project",
  path: addProjectPath,
  title: () => useProjectsText()("projects.add.title"),
  icon: "plus",
  sidebar: "main",
  view: AddProjectPage,
}
