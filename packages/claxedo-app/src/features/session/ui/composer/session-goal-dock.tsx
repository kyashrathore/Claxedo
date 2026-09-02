import { For, Show, createSignal } from "solid-js"
import type { RuntimeGoalSnapshot, RuntimeGoalStatus } from "@claxedo/agent-event-runtime"
import type { AgentRuntimeGoalCapabilities } from "@/platform/runtime/agent/agent-runtime-client"
import { supportsAgentRuntimeGoalAction } from "@/platform/runtime/agent/agent-runtime-goal-client"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/platform/i18n/provider"

type GoalAction = "pause" | "resume" | "delete"

const STATUS_KEYS = {
  active: "session.goal.status.active",
  paused: "session.goal.status.paused",
  blocked: "session.goal.status.blocked",
  limited: "session.goal.status.limited",
  complete: "session.goal.status.complete",
} as const satisfies Record<RuntimeGoalStatus, string>

export function sessionGoalControls(input: {
  goal: Pick<RuntimeGoalSnapshot, "status">
  capabilities: Pick<AgentRuntimeGoalCapabilities, "implemented" | "available" | "actions">
}) {
  const pausePair = supportsAgentRuntimeGoalAction(input.capabilities, "pause")
  return {
    pause: pausePair && input.goal.status === "active",
    resume: pausePair && input.goal.status === "paused",
    delete: supportsAgentRuntimeGoalAction(input.capabilities, "delete"),
  }
}

export function SessionGoalDock(props: {
  goal: RuntimeGoalSnapshot
  capabilities: AgentRuntimeGoalCapabilities
  onPause: () => Promise<unknown>
  onResume: () => Promise<unknown>
  onDelete: () => Promise<unknown>
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const [pending, setPending] = createSignal<GoalAction>()
  const [error, setError] = createSignal<string>()
  const controls = () => sessionGoalControls(props)
  const run = async (action: GoalAction) => {
    if (pending()) return false
    setPending(action)
    setError()
    try {
      if (action === "pause") await props.onPause()
      if (action === "resume") await props.onResume()
      if (action === "delete") await props.onDelete()
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setPending()
    }
  }
  const confirmDelete = () => dialog.show(() => (
    <Dialog title={language.t("session.goal.deleteTitle")} fit>
      <div class="flex flex-col gap-4">
        <p class="text-14-regular text-text-strong">{language.t("session.goal.deleteConfirm")}</p>
        <Show when={error()}>
          {(message) => <p role="alert" class="text-12-regular text-icon-critical-base">{message()}</p>}
        </Show>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={() => dialog.close()} disabled={pending() === "delete"}>
            {language.t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            size="large"
            disabled={pending() === "delete"}
            onClick={() => void run("delete").then((deleted) => { if (deleted) dialog.close() })}
          >
            {pending() === "delete" ? language.t("common.loading") : language.t("session.goal.delete")}
          </Button>
        </div>
      </div>
    </Dialog>
  ))
  const metrics = () => [
    props.goal.iteration !== undefined
      ? language.t("session.goal.metric.iteration", { count: props.goal.iteration })
      : undefined,
    props.goal.tokensUsed !== undefined
      ? language.t("session.goal.metric.tokensUsed", { count: props.goal.tokensUsed.toLocaleString() })
      : undefined,
    props.goal.tokenBudget !== undefined
      ? language.t("session.goal.metric.tokenBudget", { count: props.goal.tokenBudget.toLocaleString() })
      : undefined,
    props.goal.timeUsedSeconds !== undefined
      ? language.t("session.goal.metric.timeUsed", { seconds: props.goal.timeUsedSeconds })
      : undefined,
  ].filter((item): item is string => !!item)

  return (
    <section
      data-component="session-goal-dock"
      aria-label={language.t("session.goal.title")}
      class="mb-2 flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-border-weak-base bg-background-base px-3 py-2"
    >
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-12-medium text-text-strong">{language.t("session.goal.title")}</span>
          <span aria-live="polite" class="rounded-full bg-surface-raised-base px-2 py-0.5 text-11-medium text-text-base">
            {language.t(STATUS_KEYS[props.goal.status])}
          </span>
          <For each={metrics()}>{(metric) => <span class="text-11-regular text-text-weak">{metric}</span>}</For>
        </div>
        <p class="mt-0.5 break-words text-13-regular text-text-base">{props.goal.objective}</p>
        <Show when={props.goal.lastReason}>
          <p class="mt-0.5 break-words text-12-regular text-text-weak">{props.goal.lastReason}</p>
        </Show>
        <Show when={error()}>{(message) => <p role="alert" class="mt-1 text-12-regular text-icon-critical-base">{message()}</p>}</Show>
      </div>
      <div class="flex min-h-8 flex-wrap items-center justify-end gap-1">
        <Show when={controls().pause}>
          <Button variant="ghost" size="normal" disabled={!!pending()} onClick={() => void run("pause")}>
            {pending() === "pause" ? language.t("common.loading") : language.t("session.goal.pause")}
          </Button>
        </Show>
        <Show when={controls().resume}>
          <Button variant="secondary" size="normal" disabled={!!pending()} onClick={() => void run("resume")}>
            {pending() === "resume" ? language.t("common.loading") : language.t("session.goal.resume")}
          </Button>
        </Show>
        <Show when={controls().delete}>
          <Button variant="ghost" size="normal" disabled={!!pending()} onClick={confirmDelete}>
            {language.t("session.goal.delete")}
          </Button>
        </Show>
      </div>
    </section>
  )
}
