import { Suspense, lazy } from "solid-js"
import { SurfaceFallback } from "@/app/integrations/surface-fallback"
import type { SettingsContribution } from "@/app/integrations/registry"

/**
 * Presets in the Settings dialog.
 *
 * Contributed rather than listed in `app/dialogs/settings.tsx`: the dialog is
 * reached from every build, and a static import of the catalog from there would
 * put `features/tasks/**` back into a `CLAXEDO_BUILD_TASKS=0` artifact. Like
 * the content surface, this module carries nothing but the contribution, so the
 * editor arrives the first time the tab is opened.
 */
const PresetsSettings = lazy(() =>
  import("@/features/tasks/ui/presets-settings").then((module) => ({ default: module.PresetsSettings })),
)

/** The tab `DialogSettings` opens on when a Tasks surface sends the user here. */
export const TASKS_PRESETS_SETTINGS_TAB = "tasks.presets"

export const tasksPresetsSettingsSection: SettingsContribution = {
  id: TASKS_PRESETS_SETTINGS_TAB,
  tier: "claxedo-first-party",
  section: "workspace",
  label: "Presets",
  icon: "task",
  renderer: () => (
    <Suspense fallback={<SurfaceFallback />}>
      <PresetsSettings />
    </Suspense>
  ),
}
