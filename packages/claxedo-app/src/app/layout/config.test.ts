import { describe, expect, test } from "bun:test"
import {
  chromeGridDefinition,
  chromeRegionPlacement,
  defaultLayoutConfig,
  isLayoutPreset,
  layoutConfigFromLiveChromeState,
  layoutMigrate,
  sizeToken,
  sortedRegions,
} from "./config"

describe("LayoutConfig", () => {
  test("default preset is byte-identical to today's config", () => {
    const today = {
      version: 1,
      target: "web",
      regions: {
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
      },
      slots: {
        rail: { regionId: "rail", order: 0 },
        workbench: { regionId: "workbench", order: 0 },
        workspacePanel: { regionId: "workspacePanel", order: 0 },
      },
      sessionMode: "tab",
      presetId: "claxedo.default",
    }

    expect(JSON.stringify(defaultLayoutConfig())).toBe(JSON.stringify(today))
    expect(JSON.stringify(defaultLayoutConfig({ preset: "claxedo.default" }))).toBe(JSON.stringify(today))
    expect(JSON.stringify(defaultLayoutConfig({ target: "desktop" }))).toBe(JSON.stringify({ ...today, target: "desktop" }))
  })

  test("navigator-sidebar preset adds a left navigator region at order 1 and bases the panel at percent 100", () => {
    const config = defaultLayoutConfig({ preset: "claxedo.navigator-sidebar" })
    const classic = defaultLayoutConfig()

    expect(config.presetId).toBe("claxedo.navigator-sidebar")
    expect(config.regions.navigator).toEqual({
      slot: "navigator",
      side: "left",
      size: { unit: "px", value: 320 },
      visible: true,
      collapsible: true,
      docked: true,
      order: 1,
    })
    expect(config.regions.rail).toEqual(classic.regions.rail)
    expect(config.regions.workbench).toEqual(classic.regions.workbench)
    expect(config.regions.workspacePanel).toEqual({
      ...classic.regions.workspacePanel,
      size: { unit: "percent", value: 100 },
    })
    expect(config.slots.navigator).toEqual({ regionId: "navigator", order: 1 })
    expect(sortedRegions(config).map(([id]) => id)).toEqual(["rail", "navigator", "workbench", "workspacePanel"])
    expect(isLayoutPreset("claxedo.navigator-sidebar")).toBe(true)
    expect(isLayoutPreset("claxedo.banana")).toBe(false)
  })

  test("grid puts the navigator after the rail on the left under the sidebar preset", () => {
    const config = defaultLayoutConfig({ preset: "claxedo.navigator-sidebar" })

    expect(chromeGridDefinition(config).columns).toBe("260px 320px minmax(0, 1fr)")
    expect(chromeRegionPlacement(config, "navigator")).toEqual({ "grid-column": "2", "grid-row": "1" })
    expect(chromeRegionPlacement(config, "workbench")).toEqual({ "grid-column": "3", "grid-row": "1" })
    expect(chromeGridDefinition({
      ...config,
      regions: { ...config.regions, workspacePanel: { ...config.regions.workspacePanel, visible: true } },
    }).columns).toBe("260px 320px minmax(0, 1fr) 100%")
  })

  test("migration keeps an unknown preset id as default", () => {
    const stored = defaultLayoutConfig()
    const unknown = layoutMigrate({ ...stored, presetId: "claxedo.banana" })
    const missing = layoutMigrate({ ...stored, presetId: undefined })
    const sidebar = layoutMigrate({ ...stored, presetId: "claxedo.navigator-sidebar" })

    expect(unknown.dirty).toBe(true)
    expect(unknown.config.presetId).toBe("claxedo.default")
    expect(unknown.config.regions.navigator).toBeUndefined()
    expect(missing.config.presetId).toBe("claxedo.default")
    expect(sidebar.config.presetId).toBe("claxedo.navigator-sidebar")
  })

  test("migrating a sidebar-preset config without a navigator region re-adds it from the preset", () => {
    const stored = { ...defaultLayoutConfig(), presetId: "claxedo.navigator-sidebar" }
    const result = layoutMigrate(stored)

    expect(result.dirty).toBe(true)
    expect(result.config.regions.navigator).toEqual(defaultLayoutConfig({ preset: "claxedo.navigator-sidebar" }).regions.navigator)
    expect(result.config.slots.navigator).toEqual({ regionId: "navigator", order: 1 })
    expect(result.config.regions.workspacePanel.size).toEqual({ unit: "px", value: 520 })
    expect(layoutMigrate(defaultLayoutConfig(), { preset: "claxedo.navigator-sidebar" }).config.regions.navigator?.slot).toBe("navigator")
    expect(layoutMigrate(defaultLayoutConfig({ preset: "claxedo.navigator-sidebar" })).dirty).toBe(false)
  })

  test("adapts live chrome state into the sidebar preset with a navigator width", () => {
    const sized = layoutConfigFromLiveChromeState({
      preset: "claxedo.navigator-sidebar",
      rail: { collapsed: false, pinned: true, width: 260 },
      workspacePanel: { open: true, width: 640 },
      navigator: { width: 400 },
    })
    const unsized = layoutConfigFromLiveChromeState({
      preset: "claxedo.navigator-sidebar",
      rail: { collapsed: false, pinned: true, width: 260 },
      navigator: { width: Number.NaN },
    })
    const classic = layoutConfigFromLiveChromeState({
      rail: { collapsed: false, pinned: true, width: 260 },
      navigator: { width: 400 },
    })

    expect(sized.regions.navigator.size).toEqual({ unit: "px", value: 400 })
    expect(sized.regions.workspacePanel).toMatchObject({ visible: true, size: { unit: "percent", value: 100 } })
    expect(unsized.regions.navigator.size).toEqual({ unit: "px", value: 320 })
    expect(classic.regions.navigator).toBeUndefined()
    expect(classic.presetId).toBe("claxedo.default")
  })

  test("default config is serializable and keeps workbench as the center region", () => {
    const config = JSON.parse(JSON.stringify(defaultLayoutConfig({ target: "desktop" })))

    expect(config).toMatchObject({
      version: 1,
      target: "desktop",
      sessionMode: "tab",
      slots: {
        rail: { regionId: "rail" },
        workbench: { regionId: "workbench" },
        workspacePanel: { regionId: "workspacePanel" },
      },
    })
    expect(config.regions.workbench).toMatchObject({
      slot: "workbench",
      side: "center",
      visible: true,
    })
    expect(config.regions.rail.docked).toBe(true)
    expect(Object.keys(config.slots).sort()).toEqual(["rail", "workbench", "workspacePanel"])
  })

  test("migrates the Workbench-backed claxedo.state.v5 flat bag", () => {
    const result = layoutMigrate({
      workbench: {
        panes: [{ id: "pane_1", contentId: "content_1" }],
        split: { direction: "h", sizes: [1], root: { t: "leaf", id: "pane_1" } },
        contentIds: ["content_1"],
        contentRecency: ["content_1"],
        focusedPaneId: "pane_1",
        layoutSnapshots: {},
      },
      rail: { collapsed: true, pinned: false },
      workspacePanel: { open: true, mode: "review" },
    }, { target: "web" })

    expect(result.dirty).toBe(true)
    expect(result.config.target).toBe("web")
    expect(result.config.regions.rail.size).toEqual({ unit: "px", value: 0 })
    expect(result.config.regions.rail.docked).toBe(false)
    expect(result.config.regions.workspacePanel.visible).toBe(true)
    expect(result.config.regions.workbench.slot).toBe("workbench")
  })

  test("migrates the older claxedo.layout.v3 grouped flat bag", () => {
    const result = layoutMigrate({
      rail: { collapsed: false, pinned: true },
      groups: [{ id: "g-initial", tabs: { items: [], activeId: null, order: [], closedTabs: [] } }],
      split: { direction: "h", sizes: [1], focusedId: "g-initial" },
      processPane: { pendingOpen: true },
    })

    expect(result.config.regions.rail.size).toEqual({ unit: "px", value: 260 })
    expect(result.config.regions.rail.docked).toBe(true)
    expect(result.config.regions.workspacePanel.visible).toBe(true)
    expect(result.config.sessionMode).toBe("tab")
  })

  test("adapts live shell chrome state into layout config", () => {
    const pinned = layoutConfigFromLiveChromeState({
      target: "desktop",
      rail: { collapsed: false, pinned: true, width: 260 },
      workspacePanel: { open: true, width: 640 },
    })
    const collapsed = layoutConfigFromLiveChromeState({
      rail: { collapsed: true, pinned: false, width: 260 },
      workspacePanel: { open: false },
    })

    expect(pinned.target).toBe("desktop")
    expect(pinned.regions.rail.size).toEqual({ unit: "px", value: 260 })
    expect(pinned.regions.rail.docked).toBe(true)
    expect(pinned.regions.workspacePanel.size).toEqual({ unit: "px", value: 640 })
    expect(pinned.regions.workspacePanel.visible).toBe(true)
    expect(collapsed.regions.rail.size).toEqual({ unit: "px", value: 0 })
    expect(collapsed.regions.rail.docked).toBe(false)
    expect(collapsed.regions.workspacePanel.visible).toBe(false)
  })

  test("normalizes malformed config while preserving extension regions", () => {
    const result = layoutMigrate({
      version: 1,
      target: "desktop",
      sessionMode: "banana",
      regions: {
        workbench: { slot: "workbench", side: "center", size: { unit: "fr", value: 1 }, visible: true, collapsible: false },
        "agent-pane": { slot: "ext:agent-pane", side: "right", size: { unit: "px", value: 360 }, visible: true, collapsible: true },
        bad: { slot: "nope" },
      },
      slots: {},
    })

    expect(result.dirty).toBe(true)
    expect(result.config.sessionMode).toBe("tab")
    expect(result.config.regions["agent-pane"]?.slot).toBe("ext:agent-pane")
    expect(result.config.slots["ext:agent-pane"]).toEqual({ regionId: "agent-pane", order: undefined })
  })

  test("drops session-internal slots from shell layout config", () => {
    const result = layoutMigrate({
      version: 1,
      target: "web",
      sessionMode: "tab",
      regions: {
        workbench: { slot: "workbench", side: "center", size: { unit: "fr", value: 1 }, visible: true, collapsible: false },
        fileTree: { slot: "fileTree", side: "left", size: { unit: "px", value: 320 }, visible: true, collapsible: true },
        review: { slot: "review", side: "right", size: { unit: "px", value: 520 }, visible: true, collapsible: true },
        terminal: { slot: "terminal", side: "bottom", size: { unit: "px", value: 240 }, visible: true, collapsible: true },
      },
      slots: {},
    })

    expect(Object.keys(result.config.regions).sort()).toEqual(["workbench"])
    expect(result.config.slots).toEqual({ workbench: { regionId: "workbench", order: 0 } })
  })

  test("derives grid sizes from visible regions without unmounting hidden region config", () => {
    const config = defaultLayoutConfig()
    const grid = chromeGridDefinition({
      ...config,
      regions: {
        ...config.regions,
        workspacePanel: {
          ...config.regions.workspacePanel,
          visible: true,
          size: { unit: "px", value: 640 },
        },
      },
    })

    expect(sizeToken({ unit: "percent", value: 50 })).toBe("50%")
    expect(grid.columns).toBe("260px minmax(0, 1fr) 640px")
    expect(chromeRegionPlacement(config, "workbench")).toEqual({
      "grid-column": "2",
      "grid-row": "1",
    })
  })

  test("can put the rail on the right through config only", () => {
    const config = defaultLayoutConfig()
    const rightRail = {
      ...config,
      regions: {
        ...config.regions,
        rail: {
          ...config.regions.rail,
          side: "right" as const,
          order: 0,
        },
        workspacePanel: {
          ...config.regions.workspacePanel,
          visible: true,
          order: 1,
        },
      },
    }

    expect(chromeGridDefinition(rightRail).columns).toBe("minmax(0, 1fr) 260px 520px")
    expect(chromeRegionPlacement(rightRail, "workbench")).toEqual({
      "grid-column": "1",
      "grid-row": "1",
    })
    expect(chromeRegionPlacement(rightRail, "rail")).toEqual({
      "grid-column": "2",
      "grid-row": "1",
    })
    expect(chromeRegionPlacement(rightRail, "workspacePanel")).toEqual({
      "grid-column": "3",
      "grid-row": "1",
    })
  })

  test("undocked rail stays renderable without taking grid space", () => {
    const config = defaultLayoutConfig()
    const overlayRail = {
      ...config,
      regions: {
        ...config.regions,
        rail: {
          ...config.regions.rail,
          docked: false,
          size: { unit: "px", value: 260 },
        },
      },
    }

    expect(chromeGridDefinition(overlayRail).columns).toBe("minmax(0, 1fr)")
    expect(chromeRegionPlacement(overlayRail, "workbench")).toEqual({
      "grid-column": "1",
      "grid-row": "1",
    })
  })
})
