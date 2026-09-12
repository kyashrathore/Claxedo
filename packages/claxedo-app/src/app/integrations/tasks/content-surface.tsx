import { Suspense, lazy } from "solid-js"
import { SurfaceFallback } from "@/app/integrations/surface-fallback"
import type { ContentSurfaceContribution } from "@/app/integrations/content-surface-contract"

/**
 * The chunk boundary for Tasks.
 *
 * The surface is registered from the shell's secondary port wiring rather than
 * listed in `first-party-content-surfaces.tsx`: that module is reached from the
 * published local entry, whose closure must stay clear of hosted capabilities,
 * and the Tasks graph reaches the project inventory through the global sync
 * provider. This module carries nothing but the contribution, so the feature
 * itself arrives the first time a user opens the tab.
 */
const TasksSurface = lazy(() =>
  import("@/features/tasks/ui/tasks-surface").then((module) => ({ default: module.TasksSurface })),
)

export const tasksContentSurface: ContentSurfaceContribution = {
  id: "surface.content.tasks",
  tier: "claxedo-first-party",
  surface: "tasks",
  slot: "workbench",
  renderer: () => (
    <Suspense fallback={<SurfaceFallback />}>
      <TasksSurface />
    </Suspense>
  ),
}
