import { createMemo, type Accessor } from "solid-js"
import type { HarnessId } from "@/platform/identity/session-ref"
import {
  CLAXEDO_AUTO_ID,
  CLAXEDO_MANUAL_ID,
  DEFAULT_PERMISSION_SELECTION,
  findPermissionModeOption,
  permissionModeOptions,
  type AdvertisedPermissionMode,
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
  /** Modes the harness advertised for THIS session. Required for ACP harnesses. */
  advertisedModes?: Accessor<readonly AdvertisedPermissionMode[] | undefined>
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
   * Auto is the default, and it is a FALLBACK rather than a stored value: a session
   * that has never been touched, and one whose stored mode the harness no longer
   * advertises, both land here. ACP mode ids are open strings that can disappear
   * between sessions, so a stored id is a hint, never a guarantee.
   */
  const selection = createMemo<PermissionSelection>(() => input.selection() ?? DEFAULT_PERMISSION_SELECTION)

  const groups = createMemo<PermissionModeGroups | undefined>(() => {
    const harness = input.harness()
    // An UNIDENTIFIED harness still gets Claxedo's own modes. Auto and Manual are
    // ours and work everywhere — only their delivery differs — so withholding them
    // would leave the user with no permission control at all on a session whose
    // harness we merely failed to name. `pi` is the archetype for "Claxedo answers
    // locally, the harness enforces nothing", which is exactly the safe behaviour
    // for an unknown harness: it can never produce a ruleset write to the wrong
    // engine. The harness group is empty and says the harness is unidentified.
    if (!harness) {
      const safe = permissionModeOptions({ harness: "pi" })
      return {
        claxedo: safe.claxedo.map(row),
        harness: { label: "Harness", rows: [], unavailable: "Still identifying this session's harness" },
      }
    }
    const options = permissionModeOptions({ harness, advertisedModes: input.advertisedModes?.() })
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
      advertisedModes: input.advertisedModes?.(),
    })
  })

  const select = (option: PermissionModeOption) => {
    if (!permissionModeDeliverable(option.delivery.kind)) return
    const next: PermissionSelection = claxedoSelection(option) ?? { kind: "harness", modeId: option.id }
    input.onSelectionChange(next)

    const deliver = input.deliver
    const sessionID = input.sessionId()
    // A draft has no session to scope a mode to. The selection is still stored, so
    // the first real session picks it up; there is simply nothing to send yet.
    if (!deliver || !sessionID) return
    void deliver({ option, sessionID }).catch((error) => input.onDeliveryError?.({ error, option }))
  }

  return { groups, current, selection, select }
}

/**
 * Claxedo's own modes map to their own selection variants; anything else is a
 * harness mode addressed by id. Keyed on the option ID rather than on `origin`
 * alone, because `origin === "claxedo"` covers two modes now and collapsing them
 * would store Auto whichever the user picked.
 */
function claxedoSelection(option: PermissionModeOption): PermissionSelection | undefined {
  if (option.id === CLAXEDO_AUTO_ID) return { kind: "claxedo-auto" }
  if (option.id === CLAXEDO_MANUAL_ID) return { kind: "claxedo-manual" }
  return undefined
}

function harnessGroupLabel(harness: HarnessId) {
  return HARNESS_GROUP_LABELS[harness]
}

/**
 * Group headings, kept separate from `HARNESS_LABELS` in mechanisms.ts because that
 * table names the harness for prose ("Claude (SDK)") while this one heads a list of
 * that harness's own modes.
 */
const HARNESS_GROUP_LABELS: Record<HarnessId, string> = {
  opencode: "opencode",
  "claude-acp": "Claude",
  "claude-sdk": "Claude",
  "codex-acp": "Codex",
  "codex-app-server": "Codex",
  "cursor-acp": "Cursor",
  "cursor-sdk": "Cursor",
  pi: "Pi",
}
