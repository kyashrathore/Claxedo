import type { Accessor } from "solid-js"
import type { HarnessAlternative } from "@/server"
import type { HarnessSelectionSnapshot } from "../harness/controller"
import type { HarnessType } from "../harness/profile"
import { useComposerText } from "../text"
import type { ModelLoadFailure } from "./harness-picker-model-section"

type UnavailableHereInput = {
  selection: Accessor<HarnessSelectionSnapshot>
  harness: Accessor<HarnessType | undefined>
  harnessLabel: (harness: HarnessType) => string
  adopt: (alternative: HarnessAlternative) => void
}

export function createUnavailableHere(input: UnavailableHereInput): Accessor<ModelLoadFailure | undefined> {
  const t = useComposerText()
  return () => {
    const refused = input.selection().unavailableHere
    const harness = input.harness()
    if (!refused || !harness) return undefined
    const message = t("composer.unavailableHere", { harness: input.harnessLabel(harness) })
    const alternative = refused.alternative
    if (!alternative) return { message, detail: t("composer.unavailableHere.machines") }
    const via = input.harnessLabel(alternative.harness)
    return {
      message,
      detail: t("composer.unavailableHere.alternative", { model: alternative.model.name, harness: via }),
      action: { label: t("composer.unavailableHere.switch", { harness: via }), run: () => input.adopt(alternative) },
    }
  }
}
