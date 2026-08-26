export const layoutConfigVersion = 1

export type LayoutTarget = "web" | "desktop"
export type RegionSide = "left" | "right" | "top" | "bottom" | "center"
export type SessionMode = "tab" | "sidebar" | "full"
export type BuiltinSlotKind = "rail" | "workspacePanel" | "workbench"
export type ExtensionSlotKind = `ext:${string}`
export type SlotKind = BuiltinSlotKind | ExtensionSlotKind
export type RegionId = string

export type LayoutSize = {
  unit: "px" | "fr" | "percent"
  value: number
}

export type RegionConfig = {
  slot: SlotKind
  side: RegionSide
  size: LayoutSize
  visible: boolean
  collapsible: boolean
  docked?: boolean
  order?: number
}

export type SlotConfig = {
  regionId: RegionId
  order?: number
}

export type SlotConfigMap = Record<string, SlotConfig>

export type LayoutConfig = {
  version: typeof layoutConfigVersion
  target: LayoutTarget
  regions: Record<RegionId, RegionConfig>
  slots: SlotConfigMap
  sessionMode: SessionMode
  presetId?: string
}

export type LayoutMigrationResult = {
  config: LayoutConfig
  dirty: boolean
}

type FlatRail = {
  collapsed?: unknown
  pinned?: unknown
  width?: unknown
}

type FlatWorkspacePanel = {
  open?: unknown
  width?: unknown
}

const builtinSlots = new Set<BuiltinSlotKind>(["rail", "workspacePanel", "workbench"])

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isSlotKind = (value: unknown): value is SlotKind =>
  typeof value === "string" && (builtinSlots.has(value as BuiltinSlotKind) || value.startsWith("ext:"))

const isSide = (value: unknown): value is RegionSide =>
  value === "left" || value === "right" || value === "top" || value === "bottom" || value === "center"

const isSessionMode = (value: unknown): value is SessionMode =>
  value === "tab" || value === "sidebar" || value === "full"

export function defaultLayoutConfig(input: { target?: LayoutTarget } = {}): LayoutConfig {
  const target = input.target ?? "web"
  const regions: Record<RegionId, RegionConfig> = {
    rail: {
      slot: "rail",
      side: "left",
      size: { unit: "px", value: 260 },
      visible: true,
      collapsible: true,
      docked: true,
      order: 0,
    },
    workbench: {
      slot: "workbench",
      side: "center",
      size: { unit: "fr", value: 1 },
      visible: true,
      collapsible: false,
      order: 0,
    },
    workspacePanel: {
      slot: "workspacePanel",
      side: "right",
      size: { unit: "px", value: 520 },
      visible: false,
      collapsible: true,
      order: 0,
    },
  }
  return {
    version: layoutConfigVersion,
    target,
    regions,
    slots: slotMap(regions),
    sessionMode: "tab",
    presetId: "claxedo.default",
  }
}

export function layoutMigrate(input: unknown, options: { target?: LayoutTarget } = {}): LayoutMigrationResult {
  if (isLayoutConfig(input)) return normalizeLayoutConfig(input, options)
  if (isObject(input)) {
    const result = normalizeLayoutConfig(layoutConfigFromFlatState(input, options), options)
    return { ...result, dirty: true }
  }
  return { config: defaultLayoutConfig(options), dirty: true }
}

export function layoutConfigFromLiveChromeState(input: {
  target?: LayoutTarget
  rail: {
    collapsed: boolean
    pinned: boolean
    width?: number
  }
  workspacePanel?: {
    open: boolean
    width?: number
  }
}) {
  return layoutConfigFromFlatState(
    {
      rail: input.rail,
      workspacePanel: input.workspacePanel,
    },
    { target: input.target },
  )
}

export function sortedRegions(config: LayoutConfig) {
  return Object.entries(config.regions).sort(
    (a, b) =>
      regionSortIndex(a[1].side) - regionSortIndex(b[1].side) ||
      (a[1].order ?? 0) - (b[1].order ?? 0) ||
      a[0].localeCompare(b[0]),
  )
}

export function sizeToken(size: LayoutSize) {
  if (size.unit === "percent") return `${size.value}%`
  return `${size.value}${size.unit}`
}

export function chromeGridDefinition(config: LayoutConfig) {
  const left = visibleSideRegions(config, "left")
  const right = visibleSideRegions(config, "right")
  const top = visibleSideRegions(config, "top")
  const bottom = visibleSideRegions(config, "bottom")
  return {
    columns: [
      ...left.map(([, region]) => sizeToken(region.size)),
      "minmax(0, 1fr)",
      ...right.map(([, region]) => sizeToken(region.size)),
    ].join(" "),
    rows: [
      ...top.map(([, region]) => sizeToken(region.size)),
      "minmax(0, 1fr)",
      ...bottom.map(([, region]) => sizeToken(region.size)),
    ].join(" "),
    centerColumn: left.length + 1,
    centerRow: top.length + 1,
  }
}

export function chromeRegionPlacement(config: LayoutConfig, regionId: RegionId) {
  const region = config.regions[regionId]
  if (!region) return {}
  const grid = chromeGridDefinition(config)
  if (region.side === "center") {
    return {
      "grid-column": `${grid.centerColumn}`,
      "grid-row": `${grid.centerRow}`,
    }
  }
  if (region.side === "left") {
    return {
      "grid-column": `${visibleSideRegions(config, "left").findIndex(([id]) => id === regionId) + 1}`,
      "grid-row": `${grid.centerRow}`,
    }
  }
  if (region.side === "right") {
    return {
      "grid-column": `${grid.centerColumn + 1 + visibleSideRegions(config, "right").findIndex(([id]) => id === regionId)}`,
      "grid-row": `${grid.centerRow}`,
    }
  }
  if (region.side === "top") {
    return {
      "grid-column": "1 / -1",
      "grid-row": `${visibleSideRegions(config, "top").findIndex(([id]) => id === regionId) + 1}`,
    }
  }
  return {
    "grid-column": "1 / -1",
    "grid-row": `${grid.centerRow + 1 + visibleSideRegions(config, "bottom").findIndex(([id]) => id === regionId)}`,
  }
}

function normalizeLayoutConfig(config: LayoutConfig, options: { target?: LayoutTarget }): LayoutMigrationResult {
  const fallback = defaultLayoutConfig({ target: options.target ?? config.target })
  const regions: Record<RegionId, RegionConfig> = {}
  for (const [id, raw] of Object.entries(isObject(config.regions) ? config.regions : fallback.regions)) {
    const normalized = normalizeRegion(id, raw, fallback.regions[id])
    if (normalized) regions[normalized[0]] = normalized[1]
  }
  const nextRegions = regions.workbench ? regions : { ...regions, workbench: fallback.regions.workbench }
  const next: LayoutConfig = {
    version: layoutConfigVersion,
    target: options.target ?? (config.target === "desktop" ? "desktop" : "web"),
    regions: nextRegions,
    slots: slotMap(nextRegions, config.slots),
    sessionMode: isSessionMode(config.sessionMode) ? config.sessionMode : "tab",
    presetId: typeof config.presetId === "string" ? config.presetId : fallback.presetId,
  }
  return { config: next, dirty: JSON.stringify(next) !== JSON.stringify(config) }
}

function layoutConfigFromFlatState(input: Record<string, unknown>, options: { target?: LayoutTarget }): LayoutConfig {
  const config = defaultLayoutConfig(options)
  const rail = isObject(input.rail) ? (input.rail as FlatRail) : {}
  const workspacePanel = isObject(input.workspacePanel) ? (input.workspacePanel as FlatWorkspacePanel) : {}
  const oldProcessPane = isObject(input.processPane) ? input.processPane : {}
  const railCollapsed = rail.collapsed === true && rail.pinned !== true
  const railWidth = typeof rail.width === "number" && Number.isFinite(rail.width) && rail.width >= 0 ? rail.width : 260
  const workspacePanelWidth =
    typeof workspacePanel.width === "number" && Number.isFinite(workspacePanel.width) && workspacePanel.width >= 0
      ? workspacePanel.width
      : config.regions.workspacePanel.size.value
  return {
    ...config,
    regions: {
      ...config.regions,
      rail: {
        ...config.regions.rail,
        size: { unit: "px", value: railCollapsed ? 0 : railWidth },
        visible: true,
        docked: rail.pinned === true,
      },
      workspacePanel: {
        ...config.regions.workspacePanel,
        size: { unit: "px", value: workspacePanelWidth },
        visible: workspacePanel.open === true || oldProcessPane.pendingOpen === true,
      },
    },
  }
}

function normalizeRegion(regionId: RegionId, input: unknown, fallback?: RegionConfig) {
  const raw = isObject(input) ? input : {}
  const slot = isSlotKind(raw.slot) ? raw.slot : fallback?.slot
  if (!slot) return
  return [
    regionId,
    {
      slot,
      side: isSide(raw.side) ? raw.side : (fallback?.side ?? "center"),
      size: normalizeSize(raw.size, fallback?.size),
      visible: typeof raw.visible === "boolean" ? raw.visible : (fallback?.visible ?? true),
      collapsible: typeof raw.collapsible === "boolean" ? raw.collapsible : (fallback?.collapsible ?? false),
      docked: typeof raw.docked === "boolean" ? raw.docked : fallback?.docked,
      order: typeof raw.order === "number" ? raw.order : fallback?.order,
    },
  ] as const
}

function normalizeSize(input: unknown, fallback: LayoutSize = { unit: "fr", value: 1 }): LayoutSize {
  if (!isObject(input)) return fallback
  const unit = input.unit === "px" || input.unit === "percent" || input.unit === "fr" ? input.unit : fallback.unit
  const value =
    typeof input.value === "number" && Number.isFinite(input.value) && input.value >= 0 ? input.value : fallback.value
  return { unit, value }
}

function slotMap(regions: Record<RegionId, RegionConfig>, existing?: SlotConfigMap) {
  return Object.fromEntries(
    Object.entries(regions).map(([regionId, region]) => {
      const current = existing?.[region.slot]
      return [region.slot, { regionId, order: current?.order ?? region.order }]
    }),
  )
}

function isLayoutConfig(input: unknown): input is LayoutConfig {
  return isObject(input) && input.version === layoutConfigVersion && isObject(input.regions)
}

function regionSortIndex(side: RegionSide) {
  if (side === "top") return 0
  if (side === "left") return 1
  if (side === "center") return 2
  if (side === "right") return 3
  return 4
}

function visibleSideRegions(config: LayoutConfig, side: RegionSide) {
  return sortedRegions(config).filter(([, region]) => region.side === side && region.visible && region.docked !== false)
}
