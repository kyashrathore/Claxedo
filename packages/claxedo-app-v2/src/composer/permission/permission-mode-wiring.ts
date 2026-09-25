import { asRecord, readString } from "@/lib/record"
import { createResource, createSignal, type Accessor } from "solid-js"
import type { HarnessConfigApi, PlacementId, SessionRef } from "@/server"
import { showToast } from "@/ui"
import { harnessSelectionValue, isHarnessSelection, type HarnessSelection } from "@/lib/harness-selection"
import { applyPermissionMode, type SessionPermissionWriter } from "./apply"
import type { HarnessId } from "./mechanisms"
import { createComposerPermissionMode } from "./permission-mode"
import type { HarnessModeReport, PermissionSelection } from "./modes"

type WiringInput = {
  api: HarnessConfigApi
  placementId: () => PlacementId | undefined
  /** The open session whose own modes answer; absent for a draft or a held harness pick. */
  sessionRef: () => SessionRef | undefined
  /**
   * The harness the composer currently targets. Part of the resource KEY, not
   * just context: switching harness must invalidate the previous answer, or the
   * picker keeps showing the old harness's modes until a slower fetch lands —
   * which reads as the switch not having worked.
   */
  harness: () => string | undefined
  harnessSelection?: () => HarnessSelection | undefined
  /**
   * Why this harness cannot report, when it cannot.
   *
   * The draft list is a RECORDED table, not something the agent said — so it
   * answers just as confidently for a harness that failed to start as for one
   * that is running. That produced a picker offering "Codex (ACP) · Agent" one
   * line under "Codex could not start", which is worse than showing nothing:
   * the modes look like the agent's own report, and choosing one appears to set
   * a policy that can never be applied because there is no agent to apply it to.
   */
  harnessUnavailable?: () => string | undefined
  requestFailedTitle: () => string
}

type ModesResource = ReturnType<typeof permissionModesResource>

function answered(unsupported: string): HarnessModeReport {
  return { modes: [], unsupported, appliesFrom: "next-turn" }
}

function permissionModesResource(input: WiringInput) {
  const key = () => JSON.stringify({
    sessionId: input.sessionRef()?.sessionId ?? "",
    placementId: input.placementId() ?? "",
    harness: input.harness() ?? null,
    selection: input.harnessSelection?.() ?? null,
  })
  const [resource, { refetch, mutate }] = createResource(
    // A DRAFT still fetches, with an empty session id, so the
    // picker can show the harness's real modes before the first message rather
    // than a placeholder — the opening turn is when the choice matters most.
    //
    // The source is a serialized string, not an object literal, deliberately:
    // createResource compares sources with `===`, so a fresh object would
    // refetch on every upstream signal wobble even when the resolved values
    // are identical.
    key,
    async (sourceKey) => {
      const parsed = asRecord(JSON.parse(sourceKey))
      const selection = parsed ? parsed.selection : undefined
      const sessionId = readString(parsed, "sessionId") ?? ""
      const placementId = input.placementId()
      const ref = input.sessionRef()
      if (!placementId || (!sessionId && !isHarnessSelection(selection))) return undefined
      return await input.api.permissionModes({
        placementId,
        ...(sessionId && ref ? { ref } : {}),
        ...(isHarnessSelection(selection) ? { harness: harnessSelectionValue(selection) } : {}),
      })
    },
  )
  // The active mode belongs to a session, not just a harness. Retain answers
  // only for the same complete request scope while refreshing.
  return { key, resource, refetch, mutate, answers: new Map<string, HarnessModeReport>() }
}

/**
 * Four states, not two, and the two extra ones are the whole point.
 *
 * `undefined` from here means "in flight", and the picker renders that as
 * loading copy. So every state that is not in flight has to be turned into a
 * real answer, or it renders as a spinner that never resolves.
 *
 * A failed fetch leaves `latest` undefined, so without this branch a dead
 * backend is indistinguishable from a slow one.
 */
function modeReport(input: WiringInput, modes: ModesResource): HarnessModeReport | undefined {
  // Checked before the fetch result, because the fetch succeeds either way.
  // The placement-scoped read answers from the recorded table without ever
  // asking the agent, so a broken harness still returns a full, plausible
  // list — and a list is the one thing that must not be shown here.
  const unavailable = input.harnessUnavailable?.()
  if (unavailable) return answered(unavailable)
  if (modes.resource.error) {
    const detail = modes.resource.error instanceof Error ? modes.resource.error.message : String(modes.resource.error)
    return answered(`Could not load permission modes: ${detail}`)
  }
  const live = modes.resource.state === "ready" ? modes.resource() : undefined
  const key = modes.key()
  if (live) {
    modes.answers.set(key, live)
    return live
  }
  // In flight: show this scope's cached answer if we have one, and undefined
  // otherwise. Deliberately not `resource.latest` — that keeps the previous
  // harness's list on screen across a switch.
  return modes.answers.get(key)
}

function modeWriter(input: WiringInput, modes: ModesResource, clearPending: () => void): SessionPermissionWriter {
  return {
    setPermissionMode: async (call) => {
      const key = modes.key()
      const ref = input.sessionRef()
      if (!ref || ref.sessionId !== call.sessionId) throw new Error("The session is no longer open")
      const result = await input.api.setPermissionMode(ref, call.modeId)
      if (key === modes.key()) {
        // The write returns the agent's complete read-back. Install that answer
        // before clearing the optimistic choice, including when it was clamped.
        modes.answers.set(key, result)
        modes.mutate(result)
        clearPending()
        void modes.refetch()
      }
      // The harness's answer, which can name a different mode than the request.
      return { currentModeId: result.currentModeId }
    },
  }
}

/**
 * The I/O half of the composer's permission-mode picker: fetching what the
 * harness offers, writing a choice back, and reconciling the two.
 */
export function createComposerPermissionModeWiring(input: WiringInput) {
  const modes = permissionModesResource(input)
  /**
   * Optimistic value covering the gap between choosing a harness mode and the
   * refetch that confirms it.
   *
   * Needed because the harness — not Claxedo — is the store for these modes, so
   * without it the row would visibly snap back to the old value until the fetch
   * returned. Cleared on BOTH outcomes: on success the refetch supersedes it, and
   * on failure it must go or the picker keeps asserting a mode the harness
   * refused.
   */
  const [pending, setPending] = createSignal<PermissionSelection | undefined>()
  return {
    report: () => modeReport(input, modes),
    writer: () => modeWriter(input, modes, () => setPending(undefined)),
    reportError: (error: unknown) => {
      setPending(undefined)
      const detail = error instanceof Error ? error.message : String(error)
      // Says the change did not happen. Silence here would leave the user
      // believing a policy is in force that the harness never accepted.
      showToast({ title: input.requestFailedTitle(), description: `The permission mode was not changed: ${detail}` })
    },
    // The harness owns the active mode. Pending only bridges an in-flight write.
    selection: (): PermissionSelection | undefined => input.harness() ? pending() : undefined,
    onSelectionChange: (next: PermissionSelection) => {
      if (next.kind === "harness") setPending(next)
    },
    /** Re-exported so the picker's groups can suppress every option, not just the list. */
    harnessUnavailable: () => input.harnessUnavailable?.(),
  }
}

/** The composer's permission picker composed over its wiring. */
export function createComposerPermissionSurface(input: {
  api: HarnessConfigApi
  placementId: () => PlacementId | undefined
  sessionRef: () => SessionRef | undefined
  harness: Accessor<HarnessId | undefined>
  harnessSelection?: Accessor<HarnessSelection | undefined>
  harnessUnavailable: () => string | undefined
  requestFailedTitle: () => string
}) {
  const permissionModeWiring = createComposerPermissionModeWiring({
    api: input.api,
    placementId: input.placementId,
    sessionRef: input.sessionRef,
    harness: input.harness,
    harnessSelection: input.harnessSelection,
    harnessUnavailable: input.harnessUnavailable,
    requestFailedTitle: input.requestFailedTitle,
  })

  const permissionMode = createComposerPermissionMode({
    harness: input.harness,
    report: permissionModeWiring.report,
    unavailable: permissionModeWiring.harnessUnavailable,
    selection: permissionModeWiring.selection,
    onSelectionChange: permissionModeWiring.onSelectionChange,
    deliver: async ({ option, sessionId }) =>
      applyPermissionMode({ delivery: option.delivery, sessionId, client: permissionModeWiring.writer() }),
    // Drops the optimistic value as well as toasting — see `reportError`.
    onDeliveryError: ({ error }) => permissionModeWiring.reportError(error),
    sessionId: () => input.sessionRef()?.sessionId,
  })

  return { permissionModeWiring, permissionMode }
}
