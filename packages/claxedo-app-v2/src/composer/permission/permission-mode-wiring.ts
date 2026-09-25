import { useQuery } from "@tanstack/solid-query"
import { createMemo, createSignal, type Accessor } from "solid-js"
import { placementId as toPlacementId, type HarnessConfigApi, type PermissionModesRequest, type PlacementId, type Server, type SessionRef } from "@/server"
import { showToast } from "@/ui"
import { harnessSelectionValue, isHarnessSelection, type HarnessSelection } from "@/lib/harness-selection"
import { applyPermissionMode, type SessionPermissionWriter } from "./apply"
import type { HarnessId } from "./mechanisms"
import { createComposerPermissionMode } from "./permission-mode"
import type { HarnessModeReport, PermissionSelection } from "./modes"

type WiringInput = {
  api: HarnessConfigApi
  queries: Server["queries"]["harnesses"]
  placementId: () => PlacementId | undefined
  sessionRef: () => SessionRef | undefined
  harness: () => string | undefined
  harnessSelection?: () => HarnessSelection | undefined
  harnessUnavailable?: () => string | undefined
  requestFailedTitle: () => string
}

type ModesQuery = ReturnType<typeof permissionModesQuery>

const NO_PLACEMENT = toPlacementId("")

function answered(unsupported: string): HarnessModeReport {
  return { modes: [], unsupported, appliesFrom: "next-turn" }
}

function sameRequest(a: PermissionModesRequest | undefined, b: PermissionModesRequest | undefined) {
  return a?.placementId === b?.placementId && a?.ref?.sessionId === b?.ref?.sessionId && a?.harness === b?.harness
}

function permissionModesQuery(input: WiringInput) {
  const request = createMemo((): PermissionModesRequest | undefined => {
    const placementId = input.placementId()
    if (!placementId) return undefined
    const ref = input.sessionRef()
    if (ref) return { placementId, ref }
    const selection = input.harnessSelection?.()
    return isHarnessSelection(selection) ? { placementId, harness: harnessSelectionValue(selection) } : undefined
  }, undefined, { equals: sameRequest })
  return useQuery(() => {
    const current = request()
    return { ...input.queries.permissionModes(current ?? { placementId: NO_PLACEMENT }), enabled: current !== undefined }
  })
}

function modeReport(input: WiringInput, modes: ModesQuery): HarnessModeReport | undefined {
  const unavailable = input.harnessUnavailable?.()
  if (unavailable) return answered(unavailable)
  if (modes.error) return answered(`Could not load permission modes: ${modes.error.message}`)
  return modes.data
}

function modeWriter(input: WiringInput, clearPending: () => void): SessionPermissionWriter {
  return {
    setPermissionMode: async (call) => {
      const ref = input.sessionRef()
      if (!ref || ref.sessionId !== call.sessionId) throw new Error("The session is no longer open")
      const result = await input.api.setPermissionMode(ref, call.modeId)
      if (input.sessionRef()?.sessionId === ref.sessionId) clearPending()
      return { currentModeId: result.currentModeId }
    },
  }
}

export function createComposerPermissionModeWiring(input: WiringInput) {
  const modes = permissionModesQuery(input)
  const [pending, setPending] = createSignal<PermissionSelection | undefined>()
  return {
    report: () => modeReport(input, modes),
    writer: () => modeWriter(input, () => setPending(undefined)),
    reportError: (error: unknown) => {
      setPending(undefined)
      const detail = error instanceof Error ? error.message : String(error)
      showToast({ title: input.requestFailedTitle(), description: `The permission mode was not changed: ${detail}` })
    },
    selection: (): PermissionSelection | undefined => input.harness() ? pending() : undefined,
    onSelectionChange: (next: PermissionSelection) => {
      if (next.kind === "harness") setPending(next)
    },
    harnessUnavailable: () => input.harnessUnavailable?.(),
  }
}

export function createComposerPermissionSurface(input: {
  api: HarnessConfigApi
  queries: Server["queries"]["harnesses"]
  placementId: () => PlacementId | undefined
  sessionRef: () => SessionRef | undefined
  harness: Accessor<HarnessId | undefined>
  harnessSelection?: Accessor<HarnessSelection | undefined>
  harnessUnavailable: () => string | undefined
  requestFailedTitle: () => string
}) {
  const permissionModeWiring = createComposerPermissionModeWiring(input)
  const permissionMode = createComposerPermissionMode({
    harness: input.harness,
    report: permissionModeWiring.report,
    unavailable: permissionModeWiring.harnessUnavailable,
    selection: permissionModeWiring.selection,
    onSelectionChange: permissionModeWiring.onSelectionChange,
    deliver: async ({ option, sessionId }) =>
      applyPermissionMode({ delivery: option.delivery, sessionId, client: permissionModeWiring.writer() }),
    onDeliveryError: ({ error }) => permissionModeWiring.reportError(error),
    sessionId: () => input.sessionRef()?.sessionId,
  })
  return { permissionModeWiring, permissionMode }
}
