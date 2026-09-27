import { createMemo, type Accessor } from "solid-js"
import { useServer, type HarnessConfigApi, type SessionRow } from "@/server"
import { harnessSelectionValue } from "@/lib/harness-selection"
import { showToast } from "@/ui"
import type { Submission } from "./model"
import type { ComposerKey } from "./store"
import type { ComposerProps } from "./setup"
import type { useComposerText } from "./text"
import { useHarnessConfig } from "./harness/context"
import { createHarnessSelectionController, createHarnessSubmitController, type HarnessScopeInput, type HarnessSelectionSnapshot } from "./harness/controller"
import { harnessSelectionId } from "./harness/profile"
import { knownSessionModel } from "./harness/store-policy"
import { createComposerPermissionSurface } from "./permission/permission-mode-wiring"
import { harnessModesUnavailable } from "./role-gate"

export type ComposerHarness = ReturnType<typeof createComposerHarness>

function harnessScopeInput(props: ComposerProps): HarnessScopeInput {
  const view = props.view
  if (!view) return { placementId: props.placementId }
  const sessionHarness = view.row()?.harness
  return {
    placementId: view.ref.placementId,
    sessionId: view.ref.sessionId,
    sessionRef: view.ref,
    ...(sessionHarness ? { sessionHarness, sessionModel: () => knownSessionModel(sessionHarness, view.row(), view.messages()) } : {}),
  }
}

export function createComposerHarness(props: ComposerProps, key: Accessor<ComposerKey>, t: ReturnType<typeof useComposerText>) {
  const server = useServer()
  const store = useHarnessConfig()
  const controller = createHarnessSelectionController(store)
  const submit = createHarnessSubmitController(store)
  const scopeInput = createMemo(() => harnessScopeInput(props))
  const selection = createMemo(() => controller.read(key()))
  const permissionMode = permissionModeFor({ key, submit, scopeInput, selection, sessionRow: () => props.view?.row(), api: server.harnessConfig, t })
  const harness = createMemo(() => {
    const type = submit.heldHarness(key()) ?? selection().harness
    return type ? server.capabilities()?.harnesses.find((info) => info.id === harnessSelectionId(type)) : undefined
  })
  const submission = async (): Promise<Submission> => {
    const scope = key()
    await submit.settledModel(scope)
    const held = submit.heldHarness(scope)
    const model = submit.modelKeyForSubmit(scope)
    const tier = submit.serviceTierForSubmit(scope)
    await store.commitHeldHarness(scope, scopeInput())
    const type = held ?? submit.harness(scope)
    const mode = permissionMode.promptModeId()
    return {
      ...(type ? { harness: harnessSelectionId(type) } : {}),
      ...(model ? { model: { providerId: model.providerId, modelId: model.modelId } } : {}),
      ...(model?.variant ? { effort: model.variant } : {}),
      ...(tier ? { serviceTier: tier } : {}),
      ...(mode ? { permissionMode: mode } : {}),
    }
  }
  return { controller, submit, scopeInput, selection, harness, submission, permissionMode }
}

function permissionModeFor(input: {
  key: Accessor<ComposerKey>
  submit: ReturnType<typeof createHarnessSubmitController>
  scopeInput: Accessor<HarnessScopeInput>
  selection: Accessor<HarnessSelectionSnapshot>
  sessionRow: Accessor<SessionRow | undefined>
  api: HarnessConfigApi
  t: ReturnType<typeof useComposerText>
}) {
  const permissionHarness = () => {
    const type = input.selection().harness
    return type ? harnessSelectionValue(type) : undefined
  }
  return createComposerPermissionSurface({
    api: input.api,
    placementId: () => input.scopeInput().placementId,
    sessionRef: () => (input.submit.heldHarness(input.key()) ? undefined : input.scopeInput().sessionRef),
    sessionRow: input.sessionRow,
    harness: permissionHarness,
    harnessSelection: () => input.selection().harness,
    harnessUnavailable: () =>
      harnessModesUnavailable({
        isHarness: !!input.selection().harness,
        readiness: input.selection().readiness,
        configError: !!input.selection().configError,
        harness: permissionHarness(),
      }),
    onWriteFailed: (description) => showToast({ title: input.t("common.requestFailed"), description }),
  }).permissionMode
}
