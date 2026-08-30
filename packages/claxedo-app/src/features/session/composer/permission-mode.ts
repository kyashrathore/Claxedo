import { createMemo, type Accessor } from "solid-js"
import type { BuiltinHarnessId, HarnessId } from "@/platform/identity/session-ref"
import { harnessDisplayLabel } from "@/ui/harness-display"
import {
  CLAXEDO_ALLOW_SAFE_ID,
  defaultPermissionSelection,
  findPermissionModeOption,
  permissionModeOptions,
  unidentifiedHarnessModes,
  type HarnessModeReport,
  type PermissionModeOption,
  type PermissionSelection,
} from "@/features/session/permission/modes"
import { permissionModeDeliverable, type PermissionModeApplied } from "@/features/session/permission/apply"

/**
 * A single row as the picker renders it: the mode, plus whether it can actually be
 * chosen and why not.
 *
 * `selectable` is NOT cosmetic. Several modes are real in the harness but have no
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
  claxedo: readonly PermissionModeRow[]
  harness: {
    label: string
    rows: readonly PermissionModeRow[]
    /** Why this harness contributes no rows. */
    unavailable?: string
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

/**
 * The composer's permission-mode picker: what to show, what is chosen, and what
 * happens when the choice changes.
 *
 * Shape mirrors `createComposerAutoAccept` — read/write in one factory, delivery
 * injected — so the two controls behave consistently and neither can read one scope
 * while writing another.
 */
export function createComposerPermissionMode(input: {
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
    sessionID: string
  }) => Promise<PermissionModeApplied>
  onDeliveryError?: (input: { error: unknown; option: PermissionModeOption }) => void
}) {
  /**
   * The stored choice, or the default derived from what the harness reported.
   *
   * The default is computed per session rather than being a constant, because it
   * depends on the harness's own answer — including which mode it says is ALREADY
   * current, which on a resumed session is the mode genuinely in force. A constant
   * could only ever name a Claxedo mode, which is how the picker previously showed
   * a label with no relationship to what the harness was doing.
   */
  const selection = createMemo<PermissionSelection>(() => {
    const stored = input.selection()
    if (stored) return stored
    const harness = input.harness()
    if (!harness) return { kind: "claxedo", modeId: CLAXEDO_ALLOW_SAFE_ID }
    return defaultPermissionSelection({ harness, report: input.report?.() })
  })

  const groups = createMemo<PermissionModeGroups | undefined>(() => {
    const harness = input.harness()
    /*
     * A harness that could not start gets the REASON and nothing else.
     *
     * Not even Claxedo's own two options. They are offered everywhere else
     * precisely because they work everywhere — but "works everywhere" assumes
     * there is a turn to apply them to, and here the agent never came up. An
     * "Auto" row under a failed ACP connection is choosable, looks applied,
     * and changes nothing; showing the error alone is the only honest state.
     *
     * Deliberately checked BEFORE the unidentified-harness branch below: that
     * one is about not yet KNOWING the harness, which is a different and
     * recoverable situation.
     */
    const unavailable = input.unavailable?.()
    if (unavailable) {
      return { claxedo: [], harness: { label: harness ? harnessGroupLabel(harness) : "Harness", rows: [], unavailable } }
    }
    // An UNIDENTIFIED harness still gets Claxedo's own modes. Auto and Manual are
    // ours and work everywhere — only their delivery differs — so withholding them
    // would leave the user with no permission control at all on a session whose
    // harness we merely failed to name. They are locally-answered, so neither can
    // produce a ruleset write to the wrong engine.
    //
    // This used to be spelled `permissionModeOptions({ harness: "pi" })`, pi being
    // the one harness that then fell to local answering. That coupling broke when
    // pi stopped offering options at all — and it was always indirect: the case
    // wants the rung that assumes nothing about the harness, not whatever pi does.
    if (!harness) {
      return {
        claxedo: unidentifiedHarnessModes().map(row),
        harness: { label: "Harness", rows: [], unavailable: "Still identifying this session's harness" },
      }
    }
    // A DRAFT has no session id yet. That matters for `next-session` harnesses
    // (cursor): "applies to the next agent, not this session" is meaningless
    // before a session exists, and actively wrong — the first message creates
    // the session and runs under exactly this mode.
    const options = permissionModeOptions({
      harness,
      report: input.report?.(),
      hasSession: !!input.sessionId(),
    })
    return {
      claxedo: options.claxedo.map(row),
      harness: {
        label: harnessGroupLabel(harness),
        rows: options.harness.modes.map(row),
        ...(options.harness.unavailable ? { unavailable: options.harness.unavailable } : {}),
      },
    }
  })

  /**
   * The chosen mode, resolved against what this harness actually offers.
   *
   * Returns undefined when the stored selection names something the harness does not
   * advertise. The picker must show that as unresolved rather than silently falling
   * back to Auto's label while a different mode is stored — a label that disagrees
   * with the stored state is how a user ends up believing a policy is active.
   */
  const current = createMemo<PermissionModeOption | undefined>(() => {
    const harness = input.harness()
    if (!harness) return undefined
    return findPermissionModeOption({
      selection: selection(),
      harness,
      report: input.report?.(),
    })
  })

  /**
   * Only an explicit, still-advertised harness choice may travel with a prompt.
   * The derived default mirrors what the harness already reports as active, so
   * resending it is redundant and can race a harness switch with the source
   * harness's old default.
   */
  const promptModeId = () => {
    const selected = input.selection()
    const harness = input.harness()
    if (!harness || selected?.kind !== "harness") return undefined
    const option = findPermissionModeOption({
      selection: selected,
      harness,
      report: input.report?.(),
    })
    return option?.origin === "harness" ? option.id : undefined
  }

  const select = (option: PermissionModeOption) => {
    if (!permissionModeDeliverable(option.delivery.kind)) return
    const next: PermissionSelection = { kind: option.origin === "claxedo" ? "claxedo" : "harness", modeId: option.id }
    input.onSelectionChange(next)

    const deliver = input.deliver
    const sessionID = input.sessionId()
    // A draft has no session to scope a mode to. The selection is still stored, so
    // the first real session picks it up; there is simply nothing to send yet.
    if (!deliver || !sessionID) return
    void deliver({ option, sessionID }).catch((error) => input.onDeliveryError?.({ error, option }))
  }

  return { groups, current, promptModeId, selection, select }
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
  opencode: "opencode",
  "claude-sdk": "Claude",
  "codex-app-server": "Codex",
  "cursor-sdk": "Cursor",
  pi: "Pi",
}
