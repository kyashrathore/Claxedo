import { createSignal, type Accessor } from "solid-js"
import {
  applyLayoutCommand,
  railPeekCommand,
  railResizeCommand,
  railToggleCommand,
  workspacePanelVisibilityCommand,
  type LayoutCommand,
} from "./commands"
import { layoutConfigFromLiveChromeState, type LayoutConfig, type LayoutTarget } from "./config"

const HOT_ZONE_WIDTH = 48
const HOT_ZONE_HEIGHT = 48
const RAIL_MIN_WIDTH = 220
const RAIL_MAX_WIDTH = 520

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
  let committedRailWidth = input.initialRail.width ?? 260

  const baseConfig = () =>
    layoutConfigFromLiveChromeState({
      target: input.target(),
      rail: input.initialRail,
      workspacePanel,
    })

  const config = () => {
    version()
    return (["rail", "workspacePanelVisibility", "workspacePanelSize"] as const)
      .map((slot) => commands[slot])
      .filter((command): command is LayoutCommand => !!command)
      .reduce((current, command) => applyLayoutCommand(current, command), baseConfig())
  }

  const dispatch = (slot: ShellLayoutCommandSlot, command: LayoutCommand | undefined) => {
    commands = { ...commands }
    if (command) commands[slot] = command
    else delete commands[slot]
    setVersion((version) => version + 1)
  }

  const railWidth = () => {
    const region = config().regions.rail
    return region.size.unit === "px" ? region.size.value : committedRailWidth
  }
  const setRailWidth = (width: number) => {
    if (!Number.isFinite(width)) return
    if (width >= RAIL_MIN_WIDTH) committedRailWidth = Math.min(Math.max(width, RAIL_MIN_WIDTH), RAIL_MAX_WIDTH)
    collapsePending = false
    mutedUntilLeave = width < RAIL_MIN_WIDTH
    dispatch("rail", railResizeCommand(width, { minWidth: RAIL_MIN_WIDTH, maxWidth: RAIL_MAX_WIDTH }))
  }
  const railPinned = () => config().regions.rail.docked !== false
  const railExpanded = () => railWidth() > 0
  const workspacePanelWidth = () => {
    const region = config().regions.workspacePanel
    return region.size.unit === "px" ? region.size.value : (workspacePanel.width ?? 520)
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
    dispatch("rail", railPeekCommand(false, committedRailWidth))
  }

  return {
    config,
    dispatch,
    setWorkspacePanelOpen,
    setWorkspacePanelWidth,
    setRailWidth,
    committedRailWidth: () => committedRailWidth,
    // A toggle-collapse mutes the hot-zone peek until the pointer leaves the
    // corner, so hiding the rail via the toggle doesn't instantly re-peek when
    // the Show-Sidebar affordance appears under the stationary cursor.
    railMuted: () => mutedUntilLeave,
    railWidth,
    workspacePanelWidth,
    toggleRail: () => {
      mutedUntilLeave = railPinned()
      collapsePending = false
      dispatch("rail", railToggleCommand(config(), committedRailWidth))
    },
    peekRail: (expanded: boolean) => dispatch("rail", railPeekCommand(expanded, committedRailWidth)),
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
      railRect: () => { top: number; right: number; bottom: number },
    ) => {
      if (railPinned()) {
        mutedUntilLeave = false
        return
      }
      if (!railExpanded()) {
        const inHotZone = clientX <= HOT_ZONE_WIDTH && clientY <= HOT_ZONE_HEIGHT
        if (inHotZone && !mutedUntilLeave) dispatch("rail", railPeekCommand(true, committedRailWidth))
        if (!inHotZone) mutedUntilLeave = false
        return
      }
      // Only branch that needs the box, so only branch that pays to measure it.
      const rect = railRect()
      const outside = clientX > rect.right || clientY < rect.top || clientY > rect.bottom
      if (outside) collapseFloatingRail()
      else collapsePending = false
    },
  }
}
