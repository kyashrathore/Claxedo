import { createMemo, type Accessor } from "solid-js"
import type { BuiltinHarnessId, HarnessId } from "./mechanisms"
import { harnessDisplayLabel } from "@/lib/harness-catalog"
import {
  defaultPermissionSelection,
  findPermissionModeOption,
  permissionModeOptions,
  type HarnessModeReport,
  type PermissionModeOption,
  type PermissionSelection,
} from "./modes"
import { permissionModeDeliverable, type PermissionModeApplied } from "./apply"

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
  unavailable?: Accessor<string | undefined>
  selection: Accessor<PermissionSelection | undefined>
  onSelectionChange: (selection: PermissionSelection) => void
  sessionId: Accessor<string | undefined>
  deliver?: (input: {
    option: PermissionModeOption
    sessionId: string
  }) => Promise<PermissionModeApplied>
  onDeliveryError?: (input: { error: unknown; option: PermissionModeOption }) => void
}

export function createComposerPermissionMode(input: PermissionModeInput) {
  const selection = createMemo(() => storedOrDefaultSelection(input))
  const groups = createMemo(() => modeGroups(input))
  const current = createMemo(() => currentOption(input, selection()))
  return { groups, current, promptModeId: () => promptModeId(input), selection, select: (option: PermissionModeOption) => selectMode(input, option) }
}

function storedOrDefaultSelection(input: PermissionModeInput): PermissionSelection | undefined {
  const stored = input.selection()
  if (stored !== undefined) return stored
  const harness = input.harness()
  if (!harness) return undefined
  const report = input.report?.()
  if (!report || report.modes.length === 0) return undefined
  return defaultPermissionSelection({ harness, report })
}

function modeGroups(input: PermissionModeInput): PermissionModeGroups | undefined {
  const harness = input.harness()
  const unavailable = input.unavailable?.()
  if (unavailable) return { harness: { label: harness ? harnessGroupLabel(harness) : "Harness", rows: [], unavailable } }
  if (!harness) return undefined
  const options = permissionModeOptions({ harness, report: input.report?.(), hasSession: !!input.sessionId() })
  return {
    harness: {
      label: harnessGroupLabel(harness),
      rows: options.harness.modes.map(permissionModeRow),
      ...(options.harness.unavailable ? { unavailable: options.harness.unavailable } : {}),
      ...(options.harness.loading ? { loading: true } : {}),
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
