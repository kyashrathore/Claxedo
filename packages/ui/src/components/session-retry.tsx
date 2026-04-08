import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { useI18n } from "../context/i18n"
import { Card } from "./card"
import { Tooltip } from "./tooltip"
import { Spinner } from "./spinner"
import { sessionRetryMessage } from "./session-retry-text"

export function SessionRetry(props: { status: SessionStatus; show?: boolean }) {
  const i18n = useI18n()
  const status = createMemo(() => {
    if (props.status.type !== "retry" && props.status.type !== "recovering") return
    return props.status
  })
  const [seconds, setSeconds] = createSignal(0)
  createEffect(
    on(status, (current) => {
      if (!current || current.type !== "retry") return
      const update = () => {
        const s = status()
        const next = s?.type === "retry" ? s.next : undefined
        if (!next) return
        setSeconds(Math.round((next - Date.now()) / 1000))
      }
      update()
      const timer = setInterval(update, 1000)
      onCleanup(() => clearInterval(timer))
    }),
  )
  const message = createMemo(() => {
    const current = status()
    if (!current) return ""
    return sessionRetryMessage(current, i18n)
  })
  const truncated = createMemo(() => {
    const current = status()
    if (!current) return false
    if (current.type === "recovering") return false
    return current.message.length > 80
  })
  const variant = createMemo(() => {
    const current = status()
    if (!current) return "error" as const
    if (current.type === "recovering") return "warning" as const
    return "error" as const
  })
  const info = createMemo(() => {
    const current = status()
    if (!current) return ""
    if (current.type === "recovering") return current.message
    const count = Math.max(0, seconds())
    const delay = count > 0 ? i18n.t("ui.sessionTurn.retry.inSeconds", { seconds: count }) : ""
    const retrying = i18n.t("ui.sessionTurn.retry.retrying")
    const line = [retrying, delay].filter(Boolean).join(" ")
    if (!line) return i18n.t("ui.sessionTurn.retry.attempt", { attempt: current.attempt })
    return i18n.t("ui.sessionTurn.retry.attemptLine", { line, attempt: current.attempt })
  })

  return (
    <Show when={status() && (props.show ?? true)}>
      <div data-slot="session-turn-retry">
        <Card variant={variant()} class="error-card">
          <div class="flex items-start gap-2">
            <Spinner class="size-4 mt-0.5" />
            <div class="min-w-0">
              <Show when={truncated()} fallback={<div data-slot="session-turn-retry-message">{message()}</div>}>
                <Tooltip value={status()?.message ?? ""} placement="top">
                  <div data-slot="session-turn-retry-message" class="cursor-help truncate">
                    {message()}
                  </div>
                </Tooltip>
              </Show>
              <Show when={info()}>{(line) => <div data-slot="session-turn-retry-info">{line()}</div>}</Show>
            </div>
          </div>
        </Card>
      </div>
    </Show>
  )
}
