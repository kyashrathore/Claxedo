import type { Navigator, Params } from "@solidjs/router"

import { createClaxedoLayoutActions } from "../claxedo-ui/layout-actions"
import { useClaxedoEventsOptional } from "../context/claxedo-events"
import { marketplaceRoute } from "./identity/route"
import type { AppShellState } from "./app-shell-state"

export function useAppShellActions(input: {
  shell: AppShellState
  params: Params
  navigate: Navigator
}) {
  const events = useClaxedoEventsOptional()
  const handleOpenMarketplace = () => {
    input.shell.state.layout.openMarketplace()
    input.navigate(marketplaceRoute())
  }

  return {
    ...createClaxedoLayoutActions({
      params: input.params,
      navigate: (path) => input.navigate(path),
      state: input.shell.state,
      dialog: input.shell.dialog,
      directorySessionCacheActions: input.shell.directorySessionCacheActions,
      globalBootstrapActions: input.shell.globalBootstrapActions,
      projectInventoryActions: input.shell.projectInventoryActions,
      globalSDK: input.shell.globalSDK,
      layout: input.shell.layout,
      platform: input.shell.platform,
      config: input.shell.config,
      events,
      projects: input.shell.projects,
      routeWorkspaceId: input.shell.routeWorkspaceId,
      activeWorkspaceId: input.shell.activeWorkspaceId,
      activeProjectId: input.shell.activeProjectId,
      canUsePages: input.shell.canUsePages,
      flowLog: input.shell.flowLog,
    }),
    handleOpenMarketplace,
  }
}
