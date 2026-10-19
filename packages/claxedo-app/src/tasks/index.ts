import { lazyView } from "@/lib/lazy-view"

export { TASKS_PAGE_PATH } from "./links"

export const TasksPage = lazyView(() => import("./view/tasks-page").then((module) => module.TasksPage))
