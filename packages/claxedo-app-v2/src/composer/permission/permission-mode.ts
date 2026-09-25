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

/**
 * A single row as the picker renders it: the mode, plus whether it can actually be
 * chosen and why not.
 *
 * `selectable` is not cosmetic. Several modes are real in the harness but have no
 * delivery implemented on our side yet, and offering one as choosable would make the
 * picker claim a policy is active when nothing was ever sent — the failure the
 * `not-wired` result exists to expose. `permissionModeDeliverable` is the single
 * source of truth, pinned to `applyPermissionMode` by a drift test.
 */
export type PermissionModeRow = {
  option: PermissionModeOption
  selectable: boolean
  /** Why this row cannot be chosen. Set exactly when `selectable` is false. */
  blockedReason?: string
}

export type PermissionModeGroups = {
  harness: {
    label: string
    rows: readonly PermissionModeRow[]
    /** Why this harness contributes no rows. */
    unavailable?: string
    /** The report is still in flight; zero rows is not a resolved answer. */
    loading?: boolean
  }
}

const row = (option: PermissionModeOption): PermissionModeRow => {
  if (permissionModeDeliverable(option.delivery.kind)) return { option, selectable: true }
  return {
    option,
    selectable: false,
    // Deliberately says Claxedo cannot send it, not that the harness lacks it. The
    // harness DOES have these modes; the gap is on our side, and blaming the harness
    // would send someone debugging the wrong system.
    blockedReason: "Claxedo cannot apply this mode yet",
  }
}

type PermissionModeInput = {
  harness: Accessor<HarnessId | undefined>
  /**
   * What the runtime reported for THIS session. `undefined` means not fetched
   * yet — a real, transient state the picker shows as loading, distinct from a
   * harness that answered and has nothing.
   */
  report?: Accessor<HarnessModeReport | undefined>
  /** Set when the harness could not start; suppresses every option. */
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

/**
 * The composer's permission-mode picker: what to show, what is chosen, and what
 * happens when the choice changes.
 *
 * Shape mirrors `createComposerAutoAccept` — read/write in one factory, delivery
 * injected — so the two controls behave consistently and neither can read one scope
 * while writing another.
 */
export function createComposerPermissionMode(input: PermissionModeInput) {
  const selection = createMemo(() => storedOrDefaultSelection(input))
  const groups = createMemo(() => modeGroups(input))
  const current = createMemo(() => currentOption(input, selection()))
  return { groups, current, promptModeId: () => promptModeId(input), selection, select: (option: PermissionModeOption) => selectMode(input, option) }
}

/**
 * The stored choice, or the default derived from what the harness reported.
 *
 * Computed per session rather than a constant, because it depends on the
 * harness's own answer — including which mode it says is already current,
 * which on a resumed session is the mode genuinely in force. A constant
 * could only ever name a Claxedo mode, unrelated to what the harness is
 * actually doing.
 */
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
  // A failed harness exposes its failure, with no selectable permission modes.
  const unavailable = input.unavailable?.()
  if (unavailable) return { harness: { label: harness ? harnessGroupLabel(harness) : "Harness", rows: [], unavailable } }
  if (!harness) return undefined
  // A DRAFT has no session id yet. That matters for `next-session` harnesses
  // (cursor): "applies to the next agent, not this session" is meaningless
  // before a session exists, and actively wrong — the first message creates
  // the session and runs under exactly this mode.
  const options = permissionModeOptions({ harness, report: input.report?.(), hasSession: !!input.sessionId() })
  return {
    harness: {
      label: harnessGroupLabel(harness),
      rows: options.harness.modes.map(row),
      ...(options.harness.unavailable ? { unavailable: options.harness.unavailable } : {}),
      ...(options.harness.loading ? { loading: true } : {}),
    },
  }
}

/**
 * The chosen mode, resolved against what this harness actually offers.
 *
 * Returns undefined when the stored selection names something the harness does not
 * advertise. The picker must show that as unresolved rather than silently falling
 * back to Auto's label while a different mode is stored — a label that disagrees
 * with the stored state is how a user ends up believing a policy is active.
 */
function currentOption(input: PermissionModeInput, chosen: PermissionSelection | undefined): PermissionModeOption | undefined {
  const harness = input.harness()
  if (!harness || !chosen) return undefined
  return findPermissionModeOption({ selection: chosen, harness, report: input.report?.() })
}

/**
 * Only an explicit, still-advertised harness choice may travel with a prompt.
 * The derived default mirrors what the harness already reports as active, so
 * resending it is redundant and can race a harness switch with the source
 * harness's old default.
 */
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
  // A draft has no session to scope a mode to. The selection is still stored, so
  // the first real session picks it up; there is simply nothing to send yet.
  if (!deliver || !sessionId) return
  void deliver({ option, sessionId }).catch((error: unknown) => input.onDeliveryError?.({ error, option }))
}

function harnessGroupLabel(harness: HarnessId) {
  return (HARNESS_GROUP_LABELS as Partial<Record<string, string>>)[harness] ?? harnessDisplayLabel(harness)
}

/**
 * Group headings, kept separate from `HARNESS_LABELS` in mechanisms.ts because that
 * table names the harness for prose ("Claude (SDK)") while this one heads a list of
 * that harness's own modes.
 */
const HARNESS_GROUP_LABELS: Record<BuiltinHarnessId, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  pi: "Pi",
  opencode: "OpenCode",
}
