import { For, Show, createSignal } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { ClaxedoIcon as Icon } from "@/ui"
import { useDialog } from "@/ui"
import type { SessionScreenTextKey } from "../i18n"
import { useSessionScreenText } from "../text"
import { createDockAction, type DockAction } from "./dock-action"
import { goalControls, type GoalAction, type GoalActions, type GoalSnapshot, type GoalStatus } from "./model"

const STATUS_KEYS: Readonly<Record<GoalStatus, SessionScreenTextKey>> = {
  active: "sessionScreen.goal.status.active",
  paused: "sessionScreen.goal.status.paused",
  blocked: "sessionScreen.goal.status.blocked",
  limited: "sessionScreen.goal.status.limited",
  complete: "sessionScreen.goal.status.complete",
}

function goalMetrics(goal: GoalSnapshot, t: ReturnType<typeof useSessionScreenText>) {
  const rows = [
    goal.iteration !== undefined ? t("sessionScreen.goal.metric.iteration", { count: goal.iteration }) : undefined,
    goal.tokensUsed !== undefined ? t("sessionScreen.goal.metric.tokensUsed", { count: goal.tokensUsed.toLocaleString() }) : undefined,
    goal.tokenBudget !== undefined ? t("sessionScreen.goal.metric.tokenBudget", { count: goal.tokenBudget.toLocaleString() }) : undefined,
    goal.timeUsedSeconds !== undefined ? t("sessionScreen.goal.metric.timeUsed", { seconds: goal.timeUsedSeconds }) : undefined,
  ]
  return rows.filter((row): row is string => row !== undefined)
}

function GoalDeleteDialog(props: { action: DockAction<GoalAction>; remove: () => Promise<void> }) {
  const t = useSessionScreenText()
  const dialog = useDialog()
  const removing = () => props.action.runningAction() === "remove"
  return (
    <Dialog title={t("sessionScreen.goal.deleteTitle")} fit>
      <div class="flex flex-col gap-4">
        <p class="text-14-regular text-text-strong">{t("sessionScreen.goal.deleteConfirm")}</p>
        <Show when={props.action.error()}>
          {(error) => <p role="alert" class="text-12-regular text-icon-critical-base">{error().message}</p>}
        </Show>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={() => dialog.close()} disabled={removing()}>
            {t("sessionScreen.action.cancel")}
          </Button>
          <Button
            variant="primary"
            size="large"
            disabled={removing()}
            onClick={() => void props.action.run("remove", props.remove).then((removed) => removed && dialog.close())}
          >
            {t(removing() ? "sessionScreen.action.loading" : "sessionScreen.goal.delete")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export function GoalDock(props: { goal: GoalSnapshot; actions: GoalActions }) {
  const t = useSessionScreenText()
  const dialog = useDialog()
  const action = createDockAction<GoalAction>()
  const [expanded, setExpanded] = createSignal(false)
  const controls = () => goalControls(props.goal, props.actions)
  const busy = () => action.running()
  const label = (current: GoalAction, key: SessionScreenTextKey) => t(action.runningAction() === current ? "sessionScreen.action.loading" : key)
  const run = (current: "pause" | "resume") => {
    const work = props.actions[current]
    if (work) void action.run(current, work)
  }
  const confirmDelete = () => {
    const remove = props.actions.remove
    if (remove) dialog.show(() => <GoalDeleteDialog action={action} remove={remove} />)
  }
  const metrics = () => goalMetrics(props.goal, t)

  return (
    <section
      data-component="session-goal-dock"
      data-expanded={expanded() ? "true" : undefined}
      aria-label={t("sessionScreen.goal.title")}
      class="mb-2 min-w-0 rounded-xl border border-border-weak-base bg-background-base"
    >
      <button
        type="button"
        data-slot="session-goal-toggle"
        aria-expanded={expanded() ? "true" : "false"}
        onClick={() => setExpanded((value) => !value)}
        class="group/goal flex h-8 w-full min-w-0 items-center gap-2 rounded-xl px-3 text-left focus-visible:outline-none"
      >
        <span class="shrink-0 text-12-medium text-text-strong">{t("sessionScreen.goal.title")}</span>
        <span
          data-slot="session-goal-status"
          data-status={props.goal.status}
          aria-live="polite"
          class="shrink-0 rounded-full bg-surface-raised-base px-2 py-0.5 text-11-medium text-text-base"
        >
          {t(STATUS_KEYS[props.goal.status])}
        </span>
        <Show when={!expanded()}>
          <span data-slot="session-goal-objective-preview" class="min-w-0 flex-1 truncate text-13-regular text-text-weak">
            {props.goal.objective}
          </span>
        </Show>
        <span class="ml-auto inline-flex shrink-0 items-center text-text-weak opacity-60 group-hover/goal:opacity-100">
          <Icon name={expanded() ? "chevron-down" : "chevron-right"} size="small" />
        </span>
      </button>
      <Show when={expanded()}>
        <div data-slot="session-goal-body" class="flex min-w-0 flex-wrap items-end gap-2 px-3 pb-2">
          <div class="min-w-[min(100%,16rem)] flex-1">
            <p class="break-words text-13-regular text-text-base">{props.goal.objective}</p>
            <Show when={props.goal.lastReason}>
              <p class="mt-0.5 break-words text-12-regular text-text-weak">{props.goal.lastReason}</p>
            </Show>
            <Show when={metrics().length > 0}>
              <div class="mt-1 flex flex-wrap gap-2">
                <For each={metrics()}>{(metric) => <span class="text-11-regular text-text-weak">{metric}</span>}</For>
              </div>
            </Show>
            <Show when={action.error()}>{(error) => <p role="alert" class="mt-1 text-12-regular text-icon-critical-base">{error().message}</p>}</Show>
          </div>
          <div class="flex min-h-8 flex-wrap items-center justify-end gap-1">
            <Show when={controls().pause}>
              <Button variant="ghost" size="normal" disabled={busy()} onClick={() => run("pause")}>
                {label("pause", "sessionScreen.goal.pause")}
              </Button>
            </Show>
            <Show when={controls().resume}>
              <Button variant="secondary" size="normal" disabled={busy()} onClick={() => run("resume")}>
                {label("resume", "sessionScreen.goal.resume")}
              </Button>
            </Show>
            <Show when={controls().remove}>
              <Button variant="ghost" size="normal" disabled={busy()} onClick={confirmDelete}>
                {t("sessionScreen.goal.delete")}
              </Button>
            </Show>
          </div>
        </div>
      </Show>
    </section>
  )
}
