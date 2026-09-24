import { For, Show } from "solid-js"
import { Button, IconButton } from "@/ui"
import type { AttachmentState } from "../model"
import type { ComposerSetup } from "../setup"

function attachmentText(t: ComposerSetup["t"], state: Extract<AttachmentState, { kind: "failed" }>) {
  if (state.refusal) {
    return {
      title: t("composer.attachment.refused.title", { harness: state.refusal.harness }),
      detail: t("composer.attachment.refused.description", { harness: state.refusal.harness, mime: state.refusal.mime }),
    }
  }
  return {
    title: t("composer.attachment.unreadable.title"),
    detail: t("composer.attachment.unreadable.description", { filename: state.filename }),
  }
}

function StopNotice(props: { composer: ComposerSetup }) {
  const t = () => props.composer.t
  const failed = () => {
    const state = props.composer.send.stopState()
    return state.kind === "failed" ? state : undefined
  }
  return (
    <Show when={failed()}>
      {(state) => (
        <div role="alert" data-slot="composer-notice" data-tone="critical" data-error-class={state().error.class}>
          <span data-slot="composer-notice-dot" aria-hidden="true" />
          <div data-slot="composer-notice-text">
            <span data-slot="composer-notice-title">{t()(`composer.error.${state().error.class}`)}</span>
            <span data-slot="composer-notice-detail">{state().error.message}</span>
          </div>
          <IconButton icon="close-small" size="small" variant="ghost" aria-label={t()("composer.action.dismiss")} onClick={() => props.composer.send.dismissStop()} />
        </div>
      )}
    </Show>
  )
}

export function ComposerNotice(props: { composer: ComposerSetup }) {
  const composer = () => props.composer
  const t = () => composer().t
  const rejected = () => {
    const state = composer().send.state()
    return state.kind === "rejected" ? state : undefined
  }
  return (
    <>
      <StopNotice composer={composer()} />
      <Show when={rejected()}>
        {(state) => (
          <div role="alert" data-slot="composer-notice" data-tone="critical" data-error-class={state().error.class}>
            <span data-slot="composer-notice-dot" aria-hidden="true" />
            <div data-slot="composer-notice-text">
              <span data-slot="composer-notice-title">{t()(`composer.error.${state().error.class}`)}</span>
              <span data-slot="composer-notice-detail">{state().error.message}</span>
            </div>
            <Show when={state().error.retryable}>
              <Button size="small" variant="ghost" data-action="composer-retry" onClick={() => void composer().send.send()}>
                {t()("composer.action.retry")}
              </Button>
            </Show>
            <IconButton icon="close-small" size="small" variant="ghost" aria-label={t()("composer.action.dismiss")} onClick={() => composer().send.edited()} />
          </div>
        )}
      </Show>
      <For each={composer().attachments()}>
        {(state) => (
          <Show when={state.kind !== "ready" && state}>
            {(pending) => (
              <div
                role={pending().kind === "failed" ? "alert" : "status"}
                data-slot="composer-notice"
                data-tone={pending().kind === "failed" ? "critical" : "info"}
              >
                <span data-slot="composer-notice-dot" aria-hidden="true" />
                <div data-slot="composer-notice-text">
                  <Show
                    when={pending().kind === "failed" && pending()}
                    fallback={<span data-slot="composer-notice-title">{t()("composer.attachment.reading", { filename: pending().kind === "reading" ? pending().filename : "" })}</span>}
                  >
                    {(failed) => {
                      const text = attachmentText(t(), failed() as Extract<AttachmentState, { kind: "failed" }>)
                      return (
                        <>
                          <span data-slot="composer-notice-title">{text.title}</span>
                          <span data-slot="composer-notice-detail">{text.detail}</span>
                        </>
                      )
                    }}
                  </Show>
                </div>
                <IconButton
                  icon="close-small"
                  size="small"
                  variant="ghost"
                  aria-label={t()("composer.action.dismiss")}
                  onClick={() => composer().store.removeAttachment(composer().key(), pending().id)}
                />
              </div>
            )}
          </Show>
        )}
      </For>
    </>
  )
}
