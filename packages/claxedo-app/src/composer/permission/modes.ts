import type { HarnessId } from "./mechanisms"
import { harnessPermissionLabel, noModeSurfaceReason } from "./mechanisms"

export type PermissionSelection =
  | { kind: "claxedo"; modeId: string }
  | { kind: "harness"; modeId: string }

export type PermissionModeDelivery = {
  kind: "harness-permission-mode"
  modeId: string
  appliesFrom: "immediate" | "next-turn" | "next-session"
}

export type PermissionModeOption = {
  id: string
  name: string
  description?: string
  origin: "harness"
  caveat?: string
  delivery: PermissionModeDelivery
}

export type HarnessModeReport = {
  modes: readonly { id: string; name: string; description?: string; level?: "ask" | "auto" | "full" }[]
  currentModeId?: string
  unsupported?: string
  appliesFrom: "immediate" | "next-turn" | "next-session"
}

export type HarnessPermissionModes = {
  modes: readonly PermissionModeOption[]
  unavailable?: string
  loading?: boolean
}

export function harnessPermissionModes(input: {
  harness: HarnessId
  report?: HarnessModeReport
  hasSession?: boolean
}): HarnessPermissionModes {
  const label = harnessPermissionLabel(input.harness)
  const report = input.report

  const noSurface = noModeSurfaceReason(input.harness)
  if (noSurface) return { modes: [], unavailable: noSurface }

  if (!report) return { modes: [], unavailable: `Loading ${label}'s permission modes…`, loading: true }

  if (report.unsupported) return { modes: [], unavailable: report.unsupported }

  if (report.modes.length === 0) {
    return { modes: [], unavailable: `${label} has not reported any permission modes for this session` }
  }
  const caveat = report.appliesFrom === "next-session" && input.hasSession !== false ? `Applies to the next ${label} agent, not this session` : undefined
  return {
    modes: report.modes.map((mode) => ({
      id: mode.id,
      name: mode.name,
      ...(mode.description ? { description: mode.description } : {}),
      origin: "harness" as const,
      ...(caveat ? { caveat } : {}),
      delivery: { kind: "harness-permission-mode" as const, modeId: mode.id, appliesFrom: report.appliesFrom },
    })),
  }
}

export function findPermissionModeOption(input: {
  selection: PermissionSelection
  harness: HarnessId
  report?: HarnessModeReport
}): PermissionModeOption | undefined {
  const selection = input.selection
  const modeId = selection.modeId
  if (selection.kind !== "harness") return undefined
  return harnessPermissionModes(input).modes.find((mode) => mode.id === modeId)
}
