import { createSignal, Show } from "solid-js"
import { Button } from "@/ui"
import { useTranslator } from "@/i18n"
import type { AppError, SessionRef } from "@/server"
import { dictionary } from "../i18n"
import { shareForm, type ShareRequest } from "../model"
import { useAccess } from "../provider"
import { SendDisclosure } from "./send-disclosure"
import { ShareForm } from "./share-form"
import { ShareRows } from "./share-rows"
import "./access.css"

const asAppError = (error: unknown): AppError =>
  typeof error === "object" && error !== null && "class" in error
    ? (error as AppError)
    : { class: "internal", message: error instanceof Error ? error.message : String(error), retryable: false }

export function SessionShareControl(props: { readonly ref: SessionRef }) {
  const t = useTranslator(dictionary)
  const access = useAccess()
  const facts = () => access.session(props.ref)
  const [open, setOpen] = createSignal(false)
  const form = shareForm()

  const grant = async (request: ShareRequest) => {
    try {
      await access.grantShare(request.ref, { level: request.level, to: request.to })
      form.send({ type: "settled" })
    } catch (error) {
      form.send({ type: "failed", error: asAppError(error) })
    }
  }

  const share = (request: ShareRequest) => {
    form.send({ type: "share", request })
    if (form.state().kind === "granting") void grant(request)
  }

  const confirm = () => {
    form.send({ type: "confirm" })
    const state = form.state()
    if (state.kind === "granting") void grant(state.request)
  }

  const revoke = async (shareId: string) => {
    form.send({ type: "revoke", shareId })
    try {
      await access.revokeShare(props.ref, shareId)
      form.send({ type: "settled" })
    } catch (error) {
      form.send({ type: "failed", error: asAppError(error) })
    }
  }

  const busy = () => form.state().kind === "granting" || form.state().kind === "revoking"
  const confirming = () => {
    const state = form.state()
    return state.kind === "confirmingSend" ? state : undefined
  }
  const failure = () => {
    const state = form.state()
    return state.kind === "failed" ? state.error : undefined
  }

  return (
    <div data-component="session-share">
      <Show when={facts().sharesError()}>
        <Button size="small" variant="ghost" aria-label={t("access.share.retry")} onClick={() => void facts().refetchShares()}>
          {t("access.share.retry")}
        </Button>
      </Show>
      <Show when={facts().shares()?.canManageShares ? facts().shares() : undefined}>
        {(shares) => (
          <>
            <Button size="small" variant="ghost" aria-expanded={open()} aria-controls="session-share-panel" onClick={() => setOpen(!open())}>
              {t("access.share.open")}
            </Button>
            <Show when={open()}>
              <section id="session-share-panel" class="share-panel" aria-label={t("access.share.title")}>
                <h3 class="share-title">{t("access.share.title")}</h3>
                <p class="share-intro">{t("access.share.intro")}</p>
                <Show when={confirming()}>
                  {(state) => (
                    <SendDisclosure
                      state={state()}
                      onAcknowledge={(acknowledged) => form.send({ type: "acknowledge", acknowledged })}
                      onConfirm={confirm}
                      onCancel={() => form.send({ type: "cancel" })}
                    />
                  )}
                </Show>
                <ShareForm sessionRef={props.ref} busy={busy()} onShare={share} />
                <ShareRows shares={shares()} busy={busy()} onShare={share} onRevoke={(shareId) => void revoke(shareId)} sessionRef={props.ref} />
                <Show when={failure()}>
                  {(error) => (
                    <p role="alert" class="share-error">
                      {t("access.share.failed")}: {error().message}
                    </p>
                  )}
                </Show>
              </section>
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}
