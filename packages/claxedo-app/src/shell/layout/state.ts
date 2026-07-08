import { createSignal, type Accessor } from "solid-js"
import {
  applyLayoutCommand,
  railPeekCommand,
  railToggleCommand,
  workspacePanelVisibilityCommand,
  type LayoutCommand,
} from "./commands"
import { layoutConfigFromLiveChromeState, type LayoutConfig, type LayoutTarget } from "./config"

const HOT_ZONE_WIDTH = 48
const HOT_ZONE_HEIGHT = 48

type RailLayoutInput = {
  collapsed: boolean
  pinned: boolean
  width?: number
}

type WorkspacePanelLayoutInput = {
  open: boolean
  width?: number
}

type ShellLayoutCommandSlot = "rail" | "workspacePanelVisibility" | "workspacePanelSize"

export function createShellLayoutState(input: {
  target: Accessor<LayoutTarget>
  initialRail: RailLayoutInput
  initialWorkspacePanel: WorkspacePanelLayoutInput
}) {
  const [version, setVersion] = createSignal(0)
  let commands: Partial<Record<ShellLayoutCommandSlot, LayoutCommand>> = {}
  let workspacePanel = { ...input.initialWorkspacePanel }
  let railLocked = false
  let collapsePending = false
  let mutedUntilLeave = false

  const baseConfig = () => layoutConfigFromLiveChromeState({
    target: input.target(),
    rail: input.initialRail,
    workspacePanel,
  })

  const config = () => {
    version()
    return (
      (["rail", "workspacePanelVisibility", "workspacePanelSize"] as const)
        .map((slot) => commands[slot])
        .filter((command): command is LayoutCommand => !!command)
        .reduce((current, command) => applyLayoutCommand(current, command), baseConfig())
    )
  }

  const dispatch = (slot: ShellLayoutCommandSlot, command: LayoutCommand | undefined) => {
    commands = { ...commands }
    if (command) commands[slot] = command
    else delete commands[slot]
    setVersion((version) => version + 1)
  }

  const railWidth = () => {
    const region = config().regions.rail
    return region.size.unit === "px" ? region.size.value : input.initialRail.width ?? 260
  }
  const railPinned = () => config().regions.rail.docked !== false
  const railExpanded = () => railWidth() > 0
  const workspacePanelWidth = () => {
    const region = config().regions.workspacePanel
    return region.size.unit === "px" ? region.size.value : workspacePanel.width ?? 520
  }
  const setWorkspacePanelOpen = (open: boolean) => {
    workspacePanel = { ...workspacePanel, open }
    dispatch("workspacePanelVisibility", workspacePanelVisibilityCommand(open))
  }
  const setWorkspacePanelWidth = (width: number) => {
    if (!Number.isFinite(width) || width < 0 || workspacePanel.width === width) return
    workspacePanel = { ...workspacePanel, width }
    setVersion((version) => version + 1)
  }
  const collapseFloatingRail = () => {
    if (railPinned() || !railExpanded()) return
    if (railLocked) {
      collapsePending = true
      return
    }
    collapsePending = false
    dispatch("rail", railPeekCommand(false, input.initialRail.width ?? 260))
  }

  return {
    config,
    dispatch,
    setWorkspacePanelOpen,
    setWorkspacePanelWidth,
    workspacePanelWidth,
    toggleRail: () => {
      mutedUntilLeave = railPinned()
      collapsePending = false
      dispatch("rail", railToggleCommand(config(), input.initialRail.width ?? 260))
    },
    peekRail: (expanded: boolean) => dispatch("rail", railPeekCommand(expanded, input.initialRail.width ?? 260)),
    lockRail: (locked: boolean) => {
      railLocked = locked
      if (!locked && collapsePending) collapseFloatingRail()
    },
    cancelRailCollapse: () => {
      collapsePending = false
    },
    collapseFloatingRail,
    trackRailPosition: (
      clientX: number,
      clientY: number,
      railRect: { top: number; right: number; bottom: number },
    ) => {
      if (railPinned()) {
        mutedUntilLeave = false
        return
      }
      if (!railExpanded()) {
        const inHotZone = clientX <= HOT_ZONE_WIDTH && clientY <= HOT_ZONE_HEIGHT
        if (inHotZone && !mutedUntilLeave) dispatch("rail", railPeekCommand(true, input.initialRail.width ?? 260))
        if (!inHotZone) mutedUntilLeave = false
        return
      }
      const outside = clientX > railRect.right || clientY < railRect.top || clientY > railRect.bottom
      if (outside) collapseFloatingRail()
      else collapsePending = false
    },
  }
}
