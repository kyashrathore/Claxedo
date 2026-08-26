// target layer: layout
import { defaultLayoutConfig, type LayoutConfig, type LayoutTarget, type RegionConfig, type RegionId } from "./config"

export type LayoutCommand =
  | { type: "replace"; config: LayoutConfig }
  | { type: "region.update"; regionId: RegionId; region: Partial<RegionConfig> }
  | { type: "reset"; target?: LayoutTarget }

export function workspacePanelFullWidthCommand(config: LayoutConfig, restoreWidth = 520): LayoutCommand {
  const current = config.regions.workspacePanel
  const fullWidth = current?.size.unit === "percent" && current.size.value === 100
  return {
    type: "region.update",
    regionId: "workspacePanel",
    region: {
      size: fullWidth ? { unit: "px", value: restoreWidth } : { unit: "percent", value: 100 },
    },
  }
}

export function workspacePanelVisibilityCommand(visible: boolean): LayoutCommand {
  return {
    type: "region.update",
    regionId: "workspacePanel",
    region: { visible },
  }
}

export function railToggleCommand(config: LayoutConfig, expandedWidth = 260): LayoutCommand {
  const current = config.regions.rail
  const docked = current?.docked !== false
  return {
    type: "region.update",
    regionId: "rail",
    region: {
      visible: true,
      size: { unit: "px", value: docked ? 0 : expandedWidth },
      docked: !docked,
    },
  }
}

export function railPeekCommand(expanded: boolean, expandedWidth = 260): LayoutCommand {
  return {
    type: "region.update",
    regionId: "rail",
    region: {
      visible: true,
      size: { unit: "px", value: expanded ? expandedWidth : 0 },
      docked: false,
    },
  }
}

export function railResizeCommand(
  width: number,
  options: {
    minWidth?: number
    maxWidth?: number
  } = {},
): LayoutCommand {
  const minWidth = options.minWidth ?? 220
  const maxWidth = options.maxWidth ?? 520
  const nextWidth = width < minWidth ? 0 : Math.min(Math.max(width, minWidth), maxWidth)
  return {
    type: "region.update",
    regionId: "rail",
    region: {
      visible: true,
      size: { unit: "px", value: nextWidth },
      docked: nextWidth > 0,
    },
  }
}

export function applyLayoutCommand(config: LayoutConfig, command: LayoutCommand): LayoutConfig {
  if (command.type === "replace") return command.config
  if (command.type === "reset") return defaultLayoutConfig({ target: command.target ?? config.target })
  const current = config.regions[command.regionId]
  if (!current) return config
  return {
    ...config,
    regions: {
      ...config.regions,
      [command.regionId]: { ...current, ...command.region },
    },
  }
}
