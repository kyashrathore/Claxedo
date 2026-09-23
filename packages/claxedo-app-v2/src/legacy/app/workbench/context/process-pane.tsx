import { createContext, onCleanup, useContext, type Accessor, type ParentProps } from "solid-js"
import { useSDK } from "@/app/providers/sdk/sdk"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { useOptionalTerminal } from "@/features/terminal/providers/provider"
import { useClaxedoEventsOptional } from "@/app/integrations/claxedo-events"
import { can } from "@/platform/auth/role"
import { workspaceRelayPlacement } from "@/features/workspaces/data/workspace-connection"
import { useClaxedoState } from "@/app/workbench/state"
import type { ProcessPaneSubscriptions } from "@/features/processes/providers"
import {
  createProcessOwnership,
  createTerminalTabOps,
  type ProcessOwnershipState,
} from "@/features/processes/providers"
import { acquireProcessPane, type WorkspaceProcessPane } from "./process-pane-registry"

const ProcessPaneContext = createContext<WorkspaceProcessPane>()

export function useWorkspaceProcessPane(): WorkspaceProcessPane {
  const value = useContext(ProcessPaneContext)
  if (!value) throw new Error("ProcessPane context must be used within a context provider")
  return value
}

/**
 * Binds the shared per-workspace process pane (see `process-pane-registry`)
 * to this subtree. `directory` is fixed for the life of the mount; callers key
 * the mount on it. `isOpen` says whether this consumer is showing the process
 * list; the default is the workspace panel's Processes navigator for this
 * directory.
 */
export function ProcessPaneProvider(props: ParentProps<{ directory?: string; isOpen?: Accessor<boolean> }>) {
  const sdk = useSDK()
  const platform = usePlatform()
  const events = useClaxedoEventsOptional()
  const state = useClaxedoState()
  const terminal = useOptionalTerminal()
  const directory = props.directory ?? sdk.directory
  const workspaceId = () => sdk.workspace?.(directory)?.workspaceId
  const ownershipState: ProcessOwnershipState = {
    terminal: state.terminal,
    meta: {
      all: () => state.meta.all(),
      find: (predicate) => state.meta.find((meta) => predicate(meta)),
    },
    layout: {
      closeContent: state.layout.closeContent,
      openTerminal: state.layout.openTerminal,
      showContent: state.layout.showContent,
    },
  }
  const subscriptions: ProcessPaneSubscriptions | undefined = events ? {
    started: (handler) => events.on("process.started", handler),
    stopped: (handler) => events.on("process.stopped", handler),
    crashed: (handler) => events.on("process.crashed", handler),
    status: (handler) => events.on("process.status", handler),
    configChanged: (handler) => events.on("process.config.changed", handler),
  } : undefined
  const panelShowsProcesses = () => {
    const panel = state.workspacePanel.state()
    return panel.open && panel.navigator === "processes" && panel.workspaceDir === directory
  }

  const pane = acquireProcessPane({
    directory,
    isOpen: props.isOpen ?? panelShowsProcesses,
    props: {
      workspaceId: workspaceId(),
      request: platform.fetch,
      hostReady: state.ready,
      open: () => {
        state.workspacePanel.open({ workspaceDir: directory, navigator: "processes" })
      },
      close: state.workspacePanel.close,
      canMutate: () => {
        const id = workspaceId()
        return !id || can("mutate.workspace", workspaceRelayPlacement(id))
      },
      processPane: state.processPane,
      ownership: createProcessOwnership(ownershipState),
      terminalTabs: createTerminalTabOps(ownershipState),
      removeStaleTerminals: terminal?.removeStale,
      subscriptions,
    },
  })
  onCleanup(pane.release)

  return <ProcessPaneContext.Provider value={pane.api}>{props.children}</ProcessPaneContext.Provider>
}
