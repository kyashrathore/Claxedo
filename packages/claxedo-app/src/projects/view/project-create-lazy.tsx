import { lazyView } from "@/lib/lazy-view"

export const loadProjectCreate = () => Promise.all([import("./project-create-form"), import("./create-project-dialog")])

export const ProjectCreateForm = lazyView(() => import("./project-create-form").then((module) => module.ProjectCreateForm))

export const DialogCreateProject = lazyView(() => import("./create-project-dialog").then((module) => module.DialogCreateProject))
