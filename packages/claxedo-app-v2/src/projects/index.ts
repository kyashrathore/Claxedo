import type { PageEntry } from "@/shell/types"
import { useProjectsText } from "./i18n"
import { addProjectPath, projectPathPattern } from "./routes"
import { AddProjectPage } from "./view/add-project-page"
import { ProjectPage } from "./view/project-page"

export type { AddProjectFlow, CloudPlacer, ProjectCreated } from "./add-project"
export { createAddProjectFlow, useAddProjectFlow } from "./add-project"
export type { CodeHostConnection, CodeHostRepository, ProjectsServer } from "./api"
export { appErrorOf, useProjectsServer } from "./api"
export type { ProjectsKey, ProjectsText } from "./i18n"
export { dictionary as projectsDictionary, useProjectsText } from "./i18n"
export type { AddProjectEvent, AddProjectState, AddProjectStep, PlacementChoice, ProjectDraft } from "./model"
export { addProjectStep, addProjectSteps, addProjectTransition, draftProjectName, sourceLabel } from "./model"
export { addProjectPath, placementDraftPath, projectPath, projectPathPattern } from "./routes"
export type { Loaded, ProjectView } from "./store"
export { useMachines, useProject, useProjectCommands, useProjectPlacements, useProjects } from "./store"
export { AddProjectSteps } from "./view/add-project-steps"
export { createdDestination } from "./view/add-project-page"
export { placementKindLabel, PlacementList } from "./view/placement-list"
export { ProjectsSidebarSection } from "./view/project-list"

export const projectPage: PageEntry = {
  id: "project",
  path: projectPathPattern,
  title: () => useProjectsText()("projects.title"),
  icon: "folder",
  sidebar: "main",
  view: ProjectPage,
}

export const addProjectPage: PageEntry = {
  id: "add-project",
  path: addProjectPath,
  title: () => useProjectsText()("projects.add.title"),
  icon: "plus",
  sidebar: "main",
  view: AddProjectPage,
}
