import { onCleanup, type Accessor } from "solid-js"
import type { Platform } from "@/platform/runtime/platform-provider"
import type { LocalProject } from "@/app/providers/layout"
import type { ClaxedoStateApi } from "./workbench/state/index"
import { capture as phCapture, identityProps } from "@/platform/telemetry/analytics"

export function useShellAppStateSnapshot(input: {
  layoutProjects: Accessor<readonly LocalProject[]>
  state: ClaxedoStateApi
  platform: Platform
}) {
  const snapshotTimer = setTimeout(() => {
    const surfaceTypes: Record<string, number> = {}
    for (const surface of input.state.meta.all()) {
      surfaceTypes[surface.type] = (surfaceTypes[surface.type] ?? 0) + 1
    }
    phCapture("app_state_snapshot", {
      ...identityProps(),
      surface: "app_shell",
      project_count: input.layoutProjects().length,
      active_panes: input.state.wb.state.panes.length,
      active_surfaces: input.state.meta.all().length,
      split_active: input.state.wb.state.panes.length > 1,
      surface_types: surfaceTypes,
      platform: input.platform.platform,
      os: input.platform.os,
      version: input.platform.version,
    })
  }, 3000)
  onCleanup(() => clearTimeout(snapshotTimer))
}
