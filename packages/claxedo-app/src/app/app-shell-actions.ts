import type { Navigator, Params } from "@solidjs/router"

import { createClaxedoLayoutActions } from "./workbench/actions/index"
import { useClaxedoEventsOptional } from "./integrations/claxedo-events"
import { marketplaceRoute, workGraphRoute } from "@/platform/identity/route"
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
  const handleOpenWorkGraph = () => {
    input.shell.state.layout.openWorkGraph()
    input.navigate(workGraphRoute())
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
      routeDirectory: input.shell.routeDirectory,
      activeDirectory: input.shell.activeDirectory,
      activeProjectId: input.shell.activeProjectId,
      canUseDocuments: input.shell.canUseDocuments,
      flowLog: input.shell.flowLog,
    }),
    handleOpenMarketplace,
    handleOpenWorkGraph,
  }
}
