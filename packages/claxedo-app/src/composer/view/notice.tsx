import { createEffect, For } from "solid-js"
import { isHarnessHostedElsewhere } from "@/server"
import { showToast } from "@/ui"
import type { AttachmentState } from "../model"
import type { ComposerSetup } from "../setup"
import { publishComposerNotice } from "./composer-notice"
import { createHarnessElsewhereRefusal, harnessElsewhereNotice } from "./harness-elsewhere"

type FailedAttachment = Extract<AttachmentState, { kind: "failed" }>

function attachmentToast(t: ComposerSetup["t"], state: FailedAttachment) {
  if (state.refusal) {
    return {
      title: t("composer.attachment.refused.title", { harness: state.refusal.harness }),
      description: t("composer.attachment.refused.description", { harness: state.refusal.harness, mime: state.refusal.mime }),
    }
  }
  return {
    title: t("composer.attachment.unreadable.title"),
    description: t("composer.attachment.unreadable.description", { filename: state.filename }),
  }
}

export function createComposerToasts(composer: ComposerSetup) {
  const hostedElsewhere = createHarnessElsewhereRefusal(composer.send.state)
  createEffect(() => {
    const state = composer.send.state()
    if (state.kind !== "rejected") return
    if (!isHarnessHostedElsewhere(state.error)) showToast({ title: composer.t("prompt.toast.promptSendFailed.title"), description: state.error.message })
    composer.send.edited()
  })
  createEffect(() => {
    for (const state of composer.attachments()) {
      if (state.kind !== "failed") continue
      showToast(attachmentToast(composer.t, state))
      composer.store.removeAttachment(composer.key(), state.id)
    }
  })
  return { hostedElsewhere }
}

function keepSessionHarness(composer: ComposerSetup) {
  const input = composer.harnessScopeInput()
  if (input.sessionHarness) void composer.harnessController.setHarness(composer.key(), input.sessionHarness, input)
}

export function HarnessElsewhereNotice(props: { composer: ComposerSetup; refusal: ReturnType<typeof createHarnessElsewhereRefusal>; startNewSession: () => void }) {
  const { refusal, dismiss } = props.refusal
  publishComposerNotice(() => harnessElsewhereNotice(refusal(), props.composer.t, {
    startNewSession: () => { dismiss(); props.startNewSession() },
    keepSessionHarness: () => { dismiss(); keepSessionHarness(props.composer) },
  }))
  return null
}

function ReadingNotice(props: { composer: ComposerSetup; filename: string; id: string }) {
  publishComposerNotice(() => ({ kind: `attachment-reading:${props.id}`, tone: "progress", message: props.composer.t("composer.attachment.reading", { filename: props.filename }) }))
  return null
}

export function ReadingNotices(props: { composer: ComposerSetup }) {
  const reading = () => props.composer.attachments().filter((state) => state.kind === "reading")
  return <For each={reading()}>{(state) => <ReadingNotice composer={props.composer} filename={state.filename} id={state.id} />}</For>
}
