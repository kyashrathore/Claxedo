import { registerContentSurface } from "@/app/integrations/first-party-content-surfaces"
import { tasksContentSurface } from "@/app/integrations/tasks/content-surface"
import { configureTasksAppPorts } from "@/features/tasks/app-ports"
import { tasksAppPorts } from "@/app/integrations/tasks/tasks-ports"

/**
 * The whole renderer-side edge onto Tasks, in one module reached only by the
 * `__CLAXEDO_TASKS_ENABLED__` dynamic import in `secondary-feature-ports.ts`.
 *
 * A static import of this module from anywhere — or of anything it imports —
 * puts `@claxedo/tasks`, `features/tasks/**` and `app/integrations/tasks/**`
 * back into every artifact, which is the state `CLAXEDO_BUILD_TASKS=0` exists
 * to avoid. `tasks-build-selection.guard.test.ts` walks the real import graph
 * for that.
 *
 * The `tasks` content TYPE stays declared in `workbench/state/types.ts`
 * regardless: restored-tab validation runs before any dynamic import resolves,
 * and a type it does not recognize is a tab it deletes.
 */
export function loadTasksContributions() {
  configureTasksAppPorts(tasksAppPorts())
  registerContentSurface(tasksContentSurface)
}
