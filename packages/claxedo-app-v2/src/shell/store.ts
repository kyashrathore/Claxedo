import type { SetStoreFunction, Store } from "solid-js/store"
import { persistedStore, preferenceKey } from "@/lib/persisted"
import { isRecord, readFiniteNumber, readString } from "@/lib/record"
import type { SideRegion } from "./model"

export const SIDEBAR_MIN_WIDTH = 220
export const SIDEBAR_MAX_WIDTH = 520
export const SIDEBAR_DEFAULT_WIDTH = 280
export const PANEL_MIN_WIDTH = 280
export const PANEL_MAX_WIDTH = 900
export const PANEL_DEFAULT_WIDTH = 420

export type PanelPreference = { readonly width: number; readonly tab?: string }

export type ShellPreferences = {
  sidebar: SideRegion
  panel: SideRegion
  sidebarWidth: number
  panels: Record<string, PanelPreference>
}

export const defaultPanel: PanelPreference = { width: PANEL_DEFAULT_WIDTH }

function readRegion(value: unknown, fallback: SideRegion): SideRegion {
  return value === "open" || value === "collapsed" ? value : fallback
}

export function clampWidth(width: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(width)))
}

function readPanels(value: unknown): Record<string, PanelPreference> {
  const panels: Record<string, PanelPreference> = {}
  if (!isRecord(value)) return panels
  for (const [scope, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue
    const width = readFiniteNumber(entry, "width")
    if (width === undefined) continue
    panels[scope] = { width: clampWidth(width, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH), tab: readString(entry, "tab") }
  }
  return panels
}

function readPreferences(value: unknown): ShellPreferences | undefined {
  if (!isRecord(value)) return undefined
  const sidebarWidth = readFiniteNumber(value, "sidebarWidth") ?? SIDEBAR_DEFAULT_WIDTH
  return {
    sidebar: readRegion(value.sidebar, "open"),
    panel: readRegion(value.panel, "collapsed"),
    sidebarWidth: clampWidth(sidebarWidth, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH),
    panels: readPanels(value.panels),
  }
}

export function createShellPreferences(scope: string): [Store<ShellPreferences>, SetStoreFunction<ShellPreferences>] {
  return persistedStore<ShellPreferences>(
    preferenceKey("shell", scope),
    { sidebar: "open", panel: "collapsed", sidebarWidth: SIDEBAR_DEFAULT_WIDTH, panels: {} },
    readPreferences,
  )
}
