import { registerContentSurface } from "@/app/integrations/first-party-content-surfaces"
import { registerSettingsSection } from "@/app/integrations/settings-sections"
import { tasksContentSurface } from "@/app/integrations/tasks/content-surface"
import { tasksPresetsSettingsSection } from "@/app/integrations/tasks/settings-section"
import { configureTasksAppPorts } from "@/features/tasks/app-ports"
import { tasksAppPorts } from "@/app/integrations/tasks/tasks-ports"

/**
 * The whole renderer-side edge onto Tasks, in one module reached only by the
 * dynamic import in `secondary-feature-ports.ts`.
 *
 * A static import of this module from anywhere — or of anything it imports —
 * pulls `@claxedo/tasks`, `features/tasks/**` and `app/integrations/tasks/**`
 * into the chunks the shell needs before first paint. The `app-local` policy's
 * required and forbidden chunk markers measure that on a real build.
 *
 * The `tasks` content TYPE stays declared in `workbench/state/types.ts`
 * regardless: restored-tab validation runs before any dynamic import resolves,
 * and a type it does not recognize is a tab it deletes.
 */
export function loadTasksContributions() {
  configureTasksAppPorts(tasksAppPorts())
  registerContentSurface(tasksContentSurface)
  registerSettingsSection(tasksPresetsSettingsSection)
}
