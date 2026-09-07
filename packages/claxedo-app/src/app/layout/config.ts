import { isRecord } from "@/lib/record"

export const layoutConfigVersion = 1

export type LayoutTarget = "web" | "desktop"
export type LayoutPreset = "claxedo.default" | "claxedo.navigator-sidebar"
export type RegionSide = "left" | "right" | "top" | "bottom" | "center"
export type SessionMode = "tab" | "sidebar" | "full"
export type BuiltinSlotKind =
  | "rail"
  | "navigator"
  | "workspacePanel"
  | "workbench"
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
  presetId?: LayoutPreset
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

type FlatNavigator = {
  width?: unknown
}

type LayoutOptions = {
  target?: LayoutTarget
  preset?: LayoutPreset
}

const builtinSlots = new Set<BuiltinSlotKind>([
  "rail",
  "navigator",
  "workspacePanel",
  "workbench",
])

/** Membership test over the same set, without narrowing the question to its answer. */
const builtinSlotNames: ReadonlySet<string> = builtinSlots

export const isLayoutPreset = (value: unknown): value is LayoutPreset =>
  value === "claxedo.default" || value === "claxedo.navigator-sidebar"

const isSlotKind = (value: unknown): value is SlotKind =>
  typeof value === "string" && (builtinSlotNames.has(value) || value.startsWith("ext:"))

const isSide = (value: unknown): value is RegionSide =>
  value === "left" || value === "right" || value === "top" || value === "bottom" || value === "center"

const isSessionMode = (value: unknown): value is SessionMode =>
  value === "tab" || value === "sidebar" || value === "full"

export function defaultLayoutConfig(input: LayoutOptions = {}): LayoutConfig {
  const target = input.target ?? "web"
  const preset = input.preset ?? "claxedo.default"
  const navigatorSidebar = preset === "claxedo.navigator-sidebar"
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
    ...(navigatorSidebar
      ? {
        navigator: {
          slot: "navigator",
          side: "left",
          size: { unit: "px", value: 320 },
          visible: true,
          collapsible: true,
          docked: true,
          order: 1,
        } satisfies RegionConfig,
      }
      : {}),
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
      size: navigatorSidebar ? { unit: "percent", value: 100 } : { unit: "px", value: 520 },
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
    presetId: preset,
  }
}

export function layoutMigrate(input: unknown, options: LayoutOptions = {}): LayoutMigrationResult {
  if (isLayoutConfig(input)) return normalizeLayoutConfig(input, options)
  if (isRecord(input)) {
    const result = normalizeLayoutConfig(layoutConfigFromFlatState(input, options), options)
    return { ...result, dirty: true }
  }
  return { config: defaultLayoutConfig(options), dirty: true }
}

export function layoutConfigFromLiveChromeState(input: {
  target?: LayoutTarget
  preset?: LayoutPreset
  rail: {
    collapsed: boolean
    pinned: boolean
    width?: number
  }
  workspacePanel?: {
    open: boolean
    width?: number
  }
  navigator?: {
    width?: number
  }
}) {
  return layoutConfigFromFlatState({
    rail: input.rail,
    workspacePanel: input.workspacePanel,
    navigator: input.navigator,
  }, { target: input.target, preset: input.preset })
}

export function sortedRegions(config: LayoutConfig) {
  return Object.entries(config.regions).sort((a, b) =>
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
    columns: [...left.map(([, region]) => sizeToken(region.size)), "minmax(0, 1fr)", ...right.map(([, region]) => sizeToken(region.size))].join(" "),
    rows: [...top.map(([, region]) => sizeToken(region.size)), "minmax(0, 1fr)", ...bottom.map(([, region]) => sizeToken(region.size))].join(" "),
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

function normalizeLayoutConfig(config: LayoutConfig, options: LayoutOptions): LayoutMigrationResult {
  const preset = options.preset ?? (isLayoutPreset(config.presetId) ? config.presetId : "claxedo.default")
  const fallback = defaultLayoutConfig({ target: options.target ?? config.target, preset })
  const regions: Record<RegionId, RegionConfig> = {}
  for (const [id, raw] of Object.entries(isRecord(config.regions) ? config.regions : fallback.regions)) {
    const normalized = normalizeRegion(id, raw, fallback.regions[id])
    if (normalized) regions[normalized[0]] = normalized[1]
  }
  if (!regions.workbench) regions.workbench = fallback.regions.workbench
  if (fallback.regions.navigator && !regions.navigator) regions.navigator = fallback.regions.navigator
  const next: LayoutConfig = {
    version: layoutConfigVersion,
    target: options.target ?? (config.target === "desktop" ? "desktop" : "web"),
    regions,
    slots: slotMap(regions, config.slots),
    sessionMode: isSessionMode(config.sessionMode) ? config.sessionMode : "tab",
    presetId: preset,
  }
  return { config: next, dirty: JSON.stringify(next) !== JSON.stringify(config) }
}

function layoutConfigFromFlatState(input: Record<string, unknown>, options: LayoutOptions): LayoutConfig {
  const config = defaultLayoutConfig(options)
  const rail = isRecord(input.rail) ? input.rail as FlatRail : {}
  const workspacePanel = isRecord(input.workspacePanel) ? input.workspacePanel as FlatWorkspacePanel : {}
  const navigator = isRecord(input.navigator) ? input.navigator as FlatNavigator : {}
  const oldProcessPane = isRecord(input.processPane) ? input.processPane : {}
  const railCollapsed = rail.collapsed === true && rail.pinned !== true
  const railWidth = finiteWidth(rail.width) ?? 260
  const workspacePanelWidth = finiteWidth(workspacePanel.width) ?? 520
  const navigatorRegion = config.regions.navigator
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
      ...(navigatorRegion
        ? { navigator: { ...navigatorRegion, size: { unit: "px", value: finiteWidth(navigator.width) ?? 320 } } }
        : {}),
      workspacePanel: {
        ...config.regions.workspacePanel,
        size: navigatorRegion ? config.regions.workspacePanel.size : { unit: "px", value: workspacePanelWidth },
        visible: workspacePanel.open === true || oldProcessPane.pendingOpen === true,
      },
    },
  }
}

function finiteWidth(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function normalizeRegion(regionId: RegionId, input: unknown, fallback?: RegionConfig) {
  const raw = isRecord(input) ? input : {}
  const slot = isSlotKind(raw.slot) ? raw.slot : fallback?.slot
  if (!slot) return undefined
  return [
    regionId,
    {
      slot,
      side: isSide(raw.side) ? raw.side : fallback?.side ?? "center",
      size: normalizeSize(raw.size, fallback?.size),
      visible: typeof raw.visible === "boolean" ? raw.visible : fallback?.visible ?? true,
      collapsible: typeof raw.collapsible === "boolean" ? raw.collapsible : fallback?.collapsible ?? false,
      docked: typeof raw.docked === "boolean" ? raw.docked : fallback?.docked,
      order: typeof raw.order === "number" ? raw.order : fallback?.order,
    },
  ] as const
}

function normalizeSize(input: unknown, fallback: LayoutSize = { unit: "fr", value: 1 }): LayoutSize {
  if (!isRecord(input)) return fallback
  const unit = input.unit === "px" || input.unit === "percent" || input.unit === "fr" ? input.unit : fallback.unit
  const value = typeof input.value === "number" && Number.isFinite(input.value) && input.value >= 0 ? input.value : fallback.value
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
  return isRecord(input) && input.version === layoutConfigVersion && isRecord(input.regions)
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
