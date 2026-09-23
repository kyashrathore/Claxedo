import { useNavigate } from "@solidjs/router"
import { useClaxedoState } from "@/app/workbench/state/index"
import { tasksRoute, type TasksPage } from "@/platform/identity/route"

/**
 * Move the Tasks tab to one of its nested pages.
 *
 * Open then navigate, the same two steps every other surface entry takes: the
 * surface holds the page so a reload restores it, and the URL is what Back
 * walks. Passing `undefined` is the task list.
 */
export function useOpenTasksPage() {
  const state = useClaxedoState()
  const navigate = useNavigate()
  return (page?: TasksPage) => {
    state.layout.openTasks(page)
    navigate(tasksRoute(page))
  }
}
