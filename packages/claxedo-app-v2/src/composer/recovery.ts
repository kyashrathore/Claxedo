import type { Accessor } from "solid-js"
import type { useDialog } from "@/ui"
import type { HarnessScopeInput, createHarnessSelectionController } from "./harness/controller"
import { harnessRecoveryModels } from "./harness/model-items"
import type { ComposerKey, ComposerStore } from "./store"
import type { useComposerText } from "./text"
import { chooseRecoveryModel } from "./view/recovery-model-dialog"

export type ComposerRecovery = {
  readonly resend: (text: string) => void
  readonly switchModelAndResend: (text: string) => Promise<void>
}

export function createRecovery(input: {
  readonly store: ComposerStore
  readonly key: Accessor<ComposerKey>
  readonly controller: ReturnType<typeof createHarnessSelectionController>
  readonly scopeInput: Accessor<HarnessScopeInput>
  readonly send: () => Promise<unknown>
  readonly dialog: ReturnType<typeof useDialog>
  readonly t: ReturnType<typeof useComposerText>
}): ComposerRecovery {
  const resend = (text: string) => {
    input.store.setPrompt(input.key(), [{ type: "text", content: text, start: 0, end: text.length }], text.length)
    void input.send()
  }
  return {
    resend,
    switchModelAndResend: async (text) => {
      const scope = input.key()
      await input.controller.hydrate(scope, input.scopeInput())
      const selection = input.controller.read(scope)
      const candidates = harnessRecoveryModels(selection)
      if (!candidates.length) throw new Error(selection.configError ?? input.t("composer.recovery.noModels"))
      const next = await chooseRecoveryModel(input.dialog, input.t("composer.recovery.chooseModel"), candidates)
      if (!next) return
      await input.controller.setModel(scope, next, input.scopeInput())
      resend(text)
    },
  }
}
