import { type ParentProps } from "solid-js"
import { useSDK } from "@/app/providers/sdk/sdk"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { useOptionalTerminal } from "@/features/terminal/providers/provider"
import { useClaxedoEventsOptional } from "@/app/integrations/claxedo-events"
import { can } from "@/platform/auth/role"
import { workspacePlacement } from "@/features/workspaces/data/workspace-connection"
import { useClaxedoState } from "@/app/workbench/state"
import {
  ProcessPaneProvider as FeatureProcessPaneProvider,
  useProcessPane,
  type ProcessPaneSubscriptions,
} from "@/features/processes/providers"
import {
  createProcessOwnership,
  createTerminalTabOps,
  type ProcessOwnershipState,
} from "@/features/processes/providers"

export { useProcessPane }

export function ProcessPaneProvider(props: ParentProps & { surfaceId?: string }) {
  const sdk = useSDK()
  const platform = usePlatform()
  const events = useClaxedoEventsOptional()
  const state = useClaxedoState()
  const terminal = useOptionalTerminal()
  const workspaceId = () => sdk.workspace?.(sdk.directory)?.workspaceId
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
  const isOpen = () => {
    if (props.surfaceId) return state.wb.selectors.focusedContent() === props.surfaceId
    const panel = state.workspacePanel.state()
    return panel.open && panel.navigator === "processes" && panel.workspaceDir === sdk.directory
  }

  return (
    <FeatureProcessPaneProvider
      directory={sdk.directory}
      workspaceId={workspaceId()}
      request={platform.fetch}
      hostReady={state.ready}
      isOpen={isOpen}
      open={() => {
        if (props.surfaceId) {
          state.layout.showContent(props.surfaceId)
          return
        }
        state.workspacePanel.open({ workspaceDir: sdk.directory, navigator: "processes" })
      }}
      close={state.workspacePanel.close}
      canMutate={() => {
        const id = workspaceId()
        return !id || can("mutate.workspace", workspacePlacement(id))
      }}
      processPane={state.processPane}
      ownership={createProcessOwnership(ownershipState)}
      terminalTabs={createTerminalTabOps(ownershipState)}
      removeStaleTerminals={terminal?.removeStale}
      subscriptions={subscriptions}
    >
      {props.children}
    </FeatureProcessPaneProvider>
  )
}
