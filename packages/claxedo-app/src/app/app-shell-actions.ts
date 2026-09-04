import type { Navigator, Params } from "@solidjs/router"
import { checkServerHealthCached } from "@/app/connection/server-health"

import { createClaxedoLayoutActions } from "./workbench/actions/index"
import { useClaxedoEventsOptional } from "./integrations/claxedo-events"
import { useCommand } from "@/app/providers/command"
import { ADD_PROJECT_COMMAND_ID } from "@/features/session/ui/components/session-add-project-action"
import { useLanguage } from "@/platform/i18n/provider"
import { marketplaceRoute } from "@/platform/identity/route"
import type { AppShellState } from "./app-shell-state"
import { workspaceConnection } from "@/features/workspaces/data/workspace-connection"

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
  const handleUsage = async () => {
    const returnFocus = document.querySelector<HTMLElement>("[data-testid='rail-account-trigger']")
    const { DialogUsage } = await import("./dialogs/usage")
    void input.shell.dialog.show(
      () => DialogUsage({}),
      () => {
        // Kobalte restores its own pre-dialog focus during the close microtask.
        // Run after that restoration so the durable account trigger, rather
        // than the menu item that was removed, owns focus.
        setTimeout(() => {
          if (returnFocus?.isConnected) returnFocus.focus()
        }, 0)
      },
    )
  }

  const actions = createClaxedoLayoutActions({
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
    activeWorkspaceRouteId: input.shell.activeWorkspaceRouteId,
    activeProjectId: input.shell.activeProjectId,
    workspaceRouteId: input.shell.routeIdForDirectory,
    workspaceKindForRoute: (routeId) => workspaceConnection(routeId)?.kind,
    canUseDocuments: input.shell.canUseDocuments,
    // The server's own account of itself (local execution), read from its
    // health document; features take it as a port rather than reaching in.
    serverHealth: () => {
      const url = input.shell.globalSDK.url
      return url
        ? checkServerHealthCached({ url }, input.shell.platform.fetch ?? globalThis.fetch)
        : Promise.resolve(undefined)
    },
    flowLog: input.shell.flowLog,
  })

  // `handleNewProject` (directory picker -> ensureLocalProject -> open project ->
  // open a session surface on it) is only reachable from here, but two surfaces
  // outside the rail want it: the desktop menu's "Open Project..." entry, which
  // already declares `project.open` (app/entry/desktop-menu.ts) and was
  // permanently disabled because nothing registered that id, and the new-session
  // project chip's "Add project" footer row. Registering it once here is what
  // makes both real -- see features/session/ui/components/session-add-project-action.ts.
  const command = useCommand()
  const language = useLanguage()
  command.register("claxedo-project", () => [
    {
      id: ADD_PROJECT_COMMAND_ID,
      title: language.t("command.project.open"),
      category: language.t("command.category.project"),
      onSelect: () => actions.handleNewProject(),
    },
  ])

  return {
    ...actions,
    handleOpenMarketplace,
    handleUsage,
  }
}
