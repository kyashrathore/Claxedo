import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import type { AgentRuntimeStatus } from "@claxedo/agent-runtime-contract"
import { isGeminiQuotaRetry } from "@/server"
import { useTranscriptI18n } from "./i18n"
import { Card, Tooltip, Spinner } from "@/ui"

export function SessionRetry(props: { status: AgentRuntimeStatus; show?: boolean }) {
  const i18n = useTranscriptI18n()
  const retry = createMemo(() => {
    if (props.status.type !== "retry") return undefined
    return props.status
  })
  const [seconds, setSeconds] = createSignal(0)
  createEffect(
    on(retry, (current) => {
      if (!current) return
      const update = () => {
        const next = retry()?.next
        if (!next) return
        setSeconds(Math.round((next - Date.now()) / 1000))
      }
      update()
      const timer = setInterval(update, 1000)
      onCleanup(() => clearInterval(timer))
    }),
  )
  const message = createMemo(() => {
    const current = retry()
    if (!current) return ""
    if (isGeminiQuotaRetry(current.message)) {
      return i18n.t("transcript.sessionTurn.retry.geminiHot")
    }
    if (current.message.length > 80) return current.message.slice(0, 80) + "..."
    return current.message
  })
  const truncated = createMemo(() => {
    const current = retry()
    if (!current) return false
    return current.message.length > 80
  })
  const info = createMemo(() => {
    const current = retry()
    if (!current) return ""
    const count = Math.max(0, seconds())
    const delay = count > 0 ? i18n.t("transcript.sessionTurn.retry.inSeconds", { seconds: count }) : ""
    const retrying = i18n.t("transcript.sessionTurn.retry.retrying")
    const line = [retrying, delay].filter(Boolean).join(" ")
    if (!line) return i18n.t("transcript.sessionTurn.retry.attempt", { attempt: current.attempt })
    return i18n.t("transcript.sessionTurn.retry.attemptLine", { line, attempt: current.attempt })
  })

  return (
    <Show when={retry() && (props.show ?? true)}>
      <div data-slot="session-turn-retry">
        <Card variant="error" class="error-card">
          <div class="flex items-start gap-2">
            <Spinner class="size-4 mt-0.5" />
            <div class="min-w-0">
              <Show when={truncated()} fallback={<div data-slot="session-turn-retry-message">{message()}</div>}>
                <Tooltip value={retry()?.message ?? ""} placement="top">
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
