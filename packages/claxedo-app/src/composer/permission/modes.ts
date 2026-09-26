import type { HarnessId } from "./mechanisms"
import {
  harnessPermissionLabel,
  permissionMechanism,
} from "./mechanisms"

export type PermissionSelection =
  | { kind: "claxedo"; modeId: string }
  | { kind: "harness"; modeId: string }

export type PermissionModeDelivery = {
  kind: "harness-permission-mode"
  modeId: string
  appliesFrom: "next-turn" | "next-session"
}

export type PermissionModeOption = {
  id: string
  name: string
  description?: string
  origin: "harness"
  caveat?: string
  delivery: PermissionModeDelivery
}

export const NATIVE_NO_POLICY_REASON =
  "Pi does not expose a permission mode. Its tools run with the permissions of the selected Local machine or Cloud sandbox."

export type HarnessModeReport = {
  modes: readonly { id: string; name: string; description?: string; level?: "ask" | "auto" | "full" }[]
  currentModeId?: string
  unsupported?: string
  appliesFrom: "next-turn" | "next-session"
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

  if (permissionMechanism(input.harness).kind === "native-no-policy") {
    return { modes: [], unavailable: NATIVE_NO_POLICY_REASON }
  }

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

export function permissionModeOptions(input: {
  harness: HarnessId
  report?: HarnessModeReport
  hasSession?: boolean
}): { harness: HarnessPermissionModes } {
  return { harness: harnessPermissionModes(input) }
}

export function defaultPermissionSelection(input: {
  harness: HarnessId
  report?: HarnessModeReport
}): PermissionSelection | undefined {
  const report = input.report
  if (report && Array.isArray(report.modes) && report.modes.length > 0) {
    const current = report.currentModeId
      ? report.modes.find((mode) => mode.id === report.currentModeId)
      : undefined
    const chosen = current ?? report.modes.find((mode) => mode.level === "auto") ?? report.modes[0]!
    return { kind: "harness", modeId: chosen.id }
  }
  return undefined
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
