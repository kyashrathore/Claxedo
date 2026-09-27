import { createMemo, createResource, createSignal, type Accessor } from "solid-js"
import { declaredPermissionModes, effectivePermissionModeId } from "@claxedo/agent-runtime-contract"
import { harnessIdentityOf, type HarnessConfigApi, type PermissionModesRequest, type PlacementId, type SessionRef, type SessionRow } from "@/server"
import { harnessSelectionValue, sameHarnessSelection, type HarnessSelection } from "@/lib/harness-selection"
import type { HarnessId } from "./mechanisms"
import { createComposerPermissionMode } from "./permission-mode"
import type { HarnessModeReport, PermissionSelection } from "./modes"

type WiringInput = {
  api: HarnessConfigApi
  placementId: () => PlacementId | undefined
  sessionRef: () => SessionRef | undefined
  sessionRow: () => SessionRow | undefined
  harness: () => string | undefined
  harnessSelection: () => HarnessSelection | undefined
  harnessUnavailable?: () => string | undefined
  onWriteFailed: (description: string) => void
}

type Pick = { readonly key: string; readonly selection: PermissionSelection; readonly over: string | undefined }

function answered(unsupported: string): HarnessModeReport {
  return { modes: [], unsupported, appliesFrom: "next-turn" }
}

function pickScope(input: WiringInput) {
  const selection = input.harnessSelection()
  return [input.placementId() ?? "", input.sessionRef()?.sessionId ?? "", selection ? harnessSelectionValue(selection) : ""].join("\n")
}

function rowMode(input: WiringInput): string | undefined {
  if (!input.sessionRef()) return undefined
  const row = input.sessionRow()
  return row && sameHarnessSelection(row.harness, input.harnessSelection()) ? row.permissionMode : undefined
}

function createAgentModes(input: WiringInput) {
  const [opened, setOpened] = createSignal<string>()
  const request = createMemo((): PermissionModesRequest | undefined => {
    const selection = input.harnessSelection()
    const placementId = input.placementId()
    if (!selection || selection.kind !== "connection" || !placementId || opened() !== pickScope(input)) return undefined
    const ref = input.sessionRef()
    return ref ? { placementId, ref } : { placementId, harness: selection.connectionId }
  })
  const [modes] = createResource(request, (current) => input.api.permissionModes(current))
  return {
    read: (): HarnessModeReport | undefined => {
      if (!request() || modes.loading) return undefined
      if (modes.error) {
        const error: unknown = modes.error
        return answered(`Could not load permission modes: ${error instanceof Error ? error.message : String(error)}`)
      }
      return modes()
    },
    open: () => setOpened(pickScope(input)),
  }
}

function modeReport(input: WiringInput, agent: ReturnType<typeof createAgentModes>): HarnessModeReport | undefined {
  const unavailable = input.harnessUnavailable?.()
  if (unavailable) return answered(unavailable)
  const selection = input.harnessSelection()
  if (!selection) return undefined
  const declared = declaredPermissionModes(harnessIdentityOf(selection))
  if (declared) return { modes: declared.modes, appliesFrom: declared.appliesFrom }
  return agent.read()
}

function inForce(input: WiringInput, current: HarnessModeReport | undefined): string | undefined {
  const selection = input.harnessSelection()
  if (!selection) return undefined
  const stored = rowMode(input)
  if (declaredPermissionModes(harnessIdentityOf(selection))) return effectivePermissionModeId(harnessIdentityOf(selection), stored) ?? undefined
  return stored ?? current?.currentModeId
}

export function createComposerPermissionSurface(input: WiringInput & { harness: Accessor<HarnessId | undefined> }) {
  const agent = createAgentModes(input)
  const current = createMemo(() => modeReport(input, agent))
  const mode = createMemo(() => inForce(input, current()))
  const [pick, setPick] = createSignal<Pick>()
  const permissionMode = createComposerPermissionMode({
    harness: input.harness,
    report: current,
    inForce: mode,
    unavailable: () => input.harnessUnavailable?.(),
    selection: () => {
      const held = pick()
      if (!held || held.key !== pickScope(input) || !input.harness()) return undefined
      return input.sessionRef() && mode() !== held.over ? undefined : held.selection
    },
    onSelectionChange: (next) => {
      if (next.kind === "harness") setPick({ key: pickScope(input), selection: next, over: mode() })
    },
    deliver: async ({ option, sessionId }) => {
      const ref = input.sessionRef()
      if (!ref || ref.sessionId !== sessionId) throw new Error("The session is no longer open")
      await input.api.setPermissionMode(ref, option.delivery.modeId)
    },
    onDeliveryError: ({ error }) => {
      setPick(undefined)
      input.onWriteFailed(`The permission mode was not changed: ${error instanceof Error ? error.message : String(error)}`)
    },
    sessionId: () => input.sessionRef()?.sessionId,
  })
  return { permissionMode: { ...permissionMode, openModes: agent.open } }
}
