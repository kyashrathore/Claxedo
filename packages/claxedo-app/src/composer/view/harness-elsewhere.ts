import { createEffect, createSignal, type Accessor } from "solid-js"
import { isHarnessHostedElsewhere, type AppError } from "@/server"
import type { SendState } from "../model"
import type { useComposerText } from "../text"
import type { ComposerNotice } from "./notice-slot"

export type HarnessElsewhereActions = { readonly startNewSession: () => void; readonly keepSessionHarness: () => void }

export function createHarnessElsewhereRefusal(state: Accessor<SendState>) {
  const [refusal, setRefusal] = createSignal<AppError>()
  createEffect(() => {
    const current = state()
    if (current.kind === "sending") setRefusal(undefined)
    if (current.kind === "rejected" && isHarnessHostedElsewhere(current.error)) setRefusal(current.error)
  })
  return { refusal, dismiss: () => setRefusal(undefined) }
}

export function harnessElsewhereNotice(refusal: AppError | undefined, t: ReturnType<typeof useComposerText>, actions: HarnessElsewhereActions): ComposerNotice | undefined {
  if (!refusal) return undefined
  return {
    kind: "harness-hosted-elsewhere",
    tone: "warning",
    message: refusal.message,
    action: { label: t("composer.harnessElsewhere.startNew"), run: actions.startNewSession },
    secondaryAction: { label: t("composer.harnessElsewhere.keep"), run: actions.keepSessionHarness },
  }
}
