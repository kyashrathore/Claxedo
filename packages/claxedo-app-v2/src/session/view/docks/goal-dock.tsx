import { For, Show, createSignal } from "solid-js"
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle, Icon, useDialog } from "@/ui"
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

function GoalRemoveDialog(props: { action: DockAction<GoalAction>; remove: () => Promise<void> }) {
  const t = useSessionScreenText()
  const dialog = useDialog()
  const removing = () => props.action.runningAction() === "remove"
  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitle>{t("sessionScreen.goal.deleteTitle")}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p>{t("sessionScreen.goal.deleteConfirm")}</p>
        <Show when={props.action.error()}>{(error) => <p role="alert" data-slot="goal-dock-error">{error().message}</p>}</Show>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" size="large" disabled={removing()} onClick={() => dialog.close()}>
          {t("sessionScreen.action.cancel")}
        </Button>
        <Button
          variant="danger"
          size="large"
          disabled={removing()}
          onClick={() => void props.action.run("remove", props.remove).then((removed) => removed && dialog.close())}
        >
          {t(removing() ? "sessionScreen.action.loading" : "sessionScreen.goal.delete")}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

function GoalControls(props: { goal: GoalSnapshot; actions: GoalActions; action: DockAction<GoalAction> }) {
  const t = useSessionScreenText()
  const dialog = useDialog()
  const controls = () => goalControls(props.goal, props.actions)
  const busy = () => props.action.running()
  const label = (action: GoalAction, key: SessionScreenTextKey) => t(props.action.runningAction() === action ? "sessionScreen.action.loading" : key)
  const run = (action: "pause" | "resume") => {
    const work = props.actions[action]
    if (work) void props.action.run(action, work)
  }
  return (
    <div data-slot="goal-dock-controls">
      <Show when={controls().pause}>
        <Button variant="ghost" size="normal" disabled={busy()} onClick={() => run("pause")}>
          {label("pause", "sessionScreen.goal.pause")}
        </Button>
      </Show>
      <Show when={controls().resume}>
        <Button variant="neutral" size="normal" disabled={busy()} onClick={() => run("resume")}>
          {label("resume", "sessionScreen.goal.resume")}
        </Button>
      </Show>
      <Show when={controls().remove && props.actions.remove}>
        {(remove) => (
          <Button variant="ghost" size="normal" disabled={busy()} onClick={() => dialog.show(() => <GoalRemoveDialog action={props.action} remove={remove()} />)}>
            {t("sessionScreen.goal.delete")}
          </Button>
        )}
      </Show>
    </div>
  )
}

export function GoalDock(props: { goal: GoalSnapshot; actions: GoalActions }) {
  const t = useSessionScreenText()
  const action = createDockAction<GoalAction>()
  const [expanded, setExpanded] = createSignal(false)
  return (
    <section data-component="goal-dock" data-expanded={expanded() ? "true" : undefined} aria-label={t("sessionScreen.goal.title")}>
      <button type="button" data-slot="goal-dock-toggle" aria-expanded={expanded()} onClick={() => setExpanded((value) => !value)}>
        <span data-slot="goal-dock-title">{t("sessionScreen.goal.title")}</span>
        <span data-slot="goal-dock-status" data-status={props.goal.status} aria-live="polite">
          {t(STATUS_KEYS[props.goal.status])}
        </span>
        <Show when={!expanded()}>
          <span data-slot="goal-dock-preview">{props.goal.objective}</span>
        </Show>
        <span data-slot="goal-dock-chevron" aria-hidden="true">
          <Icon name={expanded() ? "chevron-down" : "chevron-right"} size="small" />
        </span>
      </button>
      <Show when={expanded()}>
        <div data-slot="goal-dock-body">
          <div data-slot="goal-dock-text">
            <p data-slot="goal-dock-objective">{props.goal.objective}</p>
            <Show when={props.goal.lastReason}>{(reason) => <p data-slot="goal-dock-reason">{reason()}</p>}</Show>
            <Show when={goalMetrics(props.goal, t).length > 0}>
              <div data-slot="goal-dock-metrics">
                <For each={goalMetrics(props.goal, t)}>{(metric) => <span>{metric}</span>}</For>
              </div>
            </Show>
            <Show when={action.error()}>{(error) => <p role="alert" data-slot="goal-dock-error">{error().message}</p>}</Show>
          </div>
          <GoalControls goal={props.goal} actions={props.actions} action={action} />
        </div>
      </Show>
    </section>
  )
}
