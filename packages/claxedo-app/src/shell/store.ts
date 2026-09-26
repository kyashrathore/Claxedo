import type { SetStoreFunction, Store } from "solid-js/store"
import { persistedStore, preferenceKey } from "@/lib/persisted"
import { isRecord } from "@claxedo/helpers/guards"
import { readFiniteNumber } from "@/lib/record"
import type { SideRegion } from "./model"

export const SIDEBAR_MIN_WIDTH = 220
export const SIDEBAR_MAX_WIDTH = 520
export const SIDEBAR_DEFAULT_WIDTH = 260

export type ShellPreferences = {
  sidebar: SideRegion
  panel: SideRegion
  sidebarWidth: number
}

function readRegion(value: unknown, fallback: SideRegion): SideRegion {
  return value === "open" || value === "collapsed" ? value : fallback
}

export function clampWidth(width: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(width)))
}

function readPreferences(value: unknown): ShellPreferences | undefined {
  if (!isRecord(value)) return undefined
  const sidebarWidth = readFiniteNumber(value, "sidebarWidth") ?? SIDEBAR_DEFAULT_WIDTH
  return {
    sidebar: readRegion(value.sidebar, "open"),
    panel: readRegion(value.panel, "collapsed"),
    sidebarWidth: clampWidth(sidebarWidth, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH),
  }
}

export function createShellPreferences(scope: string): [Store<ShellPreferences>, SetStoreFunction<ShellPreferences>] {
  return persistedStore<ShellPreferences>(
    preferenceKey("shell", scope),
    { sidebar: "open", panel: "collapsed", sidebarWidth: SIDEBAR_DEFAULT_WIDTH },
    readPreferences,
  )
}
