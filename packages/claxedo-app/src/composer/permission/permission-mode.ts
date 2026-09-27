import { createMemo, type Accessor } from "solid-js"
import type { BuiltinHarnessId, HarnessId } from "./mechanisms"
import { harnessDisplayLabel } from "@/lib/harness-catalog"
import {
  findPermissionModeOption,
  harnessPermissionModes,
  type HarnessModeReport,
  type PermissionModeOption,
  type PermissionSelection,
} from "./modes"
import { permissionModeDeliverable } from "./apply"

export type PermissionModeRow = {
  option: PermissionModeOption
  selectable: boolean
  blockedReason?: string
}

export type PermissionModeGroups = {
  harness: {
    label: string
    rows: readonly PermissionModeRow[]
    unavailable?: string
    loading?: boolean
  }
}

const permissionModeRow = (option: PermissionModeOption): PermissionModeRow => {
  if (permissionModeDeliverable(option.delivery.kind)) return { option, selectable: true }
  return {
    option,
    selectable: false,
    blockedReason: "Claxedo cannot apply this mode yet",
  }
}

type PermissionModeInput = {
  harness: Accessor<HarnessId | undefined>
  report?: Accessor<HarnessModeReport | undefined>
  inForce: Accessor<string | undefined>
  unavailable?: Accessor<string | undefined>
  selection: Accessor<PermissionSelection | undefined>
  onSelectionChange: (selection: PermissionSelection) => void
  sessionId: Accessor<string | undefined>
  deliver?: (input: {
    option: PermissionModeOption
    sessionId: string
  }) => Promise<void>
  onDeliveryError?: (input: { error: unknown; option: PermissionModeOption }) => void
}

export function createComposerPermissionMode(input: PermissionModeInput) {
  const selection = createMemo((): PermissionSelection | undefined => {
    const picked = input.selection()
    if (picked !== undefined) return picked
    const modeId = input.harness() ? input.inForce() : undefined
    return modeId ? { kind: "harness", modeId } : undefined
  })
  const groups = createMemo(() => modeGroups(input))
  const current = createMemo(() => currentOption(input, selection()))
  return { groups, current, promptModeId: () => promptModeId(input), selection, select: (option: PermissionModeOption) => selectMode(input, option) }
}

function modeGroups(input: PermissionModeInput): PermissionModeGroups | undefined {
  const harness = input.harness()
  const unavailable = input.unavailable?.()
  if (unavailable) return { harness: { label: harness ? harnessGroupLabel(harness) : "Harness", rows: [], unavailable } }
  if (!harness) return undefined
  const options = harnessPermissionModes({ harness, report: input.report?.(), hasSession: !!input.sessionId() })
  return {
    harness: {
      label: harnessGroupLabel(harness),
      rows: options.modes.map(permissionModeRow),
      ...(options.unavailable ? { unavailable: options.unavailable } : {}),
      ...(options.loading ? { loading: true } : {}),
    },
  }
}

function currentOption(input: PermissionModeInput, chosen: PermissionSelection | undefined): PermissionModeOption | undefined {
  const harness = input.harness()
  if (!harness || !chosen) return undefined
  return findPermissionModeOption({ selection: chosen, harness, report: input.report?.() })
}

function promptModeId(input: PermissionModeInput) {
  const selected = input.selection()
  if (selected?.kind !== "harness") return undefined
  const option = currentOption(input, selected)
  return option?.origin === "harness" ? option.id : undefined
}

function selectMode(input: PermissionModeInput, option: PermissionModeOption) {
  if (!permissionModeDeliverable(option.delivery.kind)) return
  input.onSelectionChange({ kind: "harness", modeId: option.id })
  const deliver = input.deliver
  const sessionId = input.sessionId()
  if (!deliver || !sessionId) return
  void deliver({ option, sessionId }).catch((error: unknown) => input.onDeliveryError?.({ error, option }))
}

function harnessGroupLabel(harness: HarnessId) {
  return (HARNESS_GROUP_LABELS as Partial<Record<string, string>>)[harness] ?? harnessDisplayLabel(harness)
}

const HARNESS_GROUP_LABELS: Record<BuiltinHarnessId, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  pi: "Pi",
  opencode: "OpenCode",
}
