import { Match, Show, Switch } from "solid-js"
import { useErrorCopy, useTranslator } from "@/i18n"
import { toAppError, useServer, type Machine, type MachineEnrollment } from "@/server"
import { Button, requestConfirm, showToast, useDialog } from "@/ui"
import { settingsDictionary, type SettingsKey } from "../i18n"
import { machineActions, type ActionState, type MachineAction } from "../machines"

const FAILED_KEY = {
  pause: "settings.machines.pause.failed",
  resume: "settings.machines.resume.failed",
  remove: "settings.machines.remove.failed",
} as const satisfies Record<MachineAction, SettingsKey>

function ActionRow(props: { readonly title: string; readonly description: string; readonly label: string; readonly danger?: boolean; readonly busy: boolean; readonly onPress: () => void }) {
  return (
    <div class="settings-inline settings-machine-action">
      <span class="settings-machine-action-text">
        <span class="settings-row-title">{props.title}</span>
        <span class="settings-row-description">{props.description}</span>
      </span>
      <Button size="small" variant={props.danger ? "danger" : "neutral"} disabled={props.busy} onClick={() => props.onPress()}>
        {props.label}
      </Button>
    </div>
  )
}

function ActionNotice(props: { readonly state: ActionState; readonly name: string }) {
  const t = useTranslator(settingsDictionary)
  const errorCopy = useErrorCopy("machines")
  return (
    <Switch>
      <Match when={props.state.kind === "done" && props.state}>
        {(done) => <p class="settings-row-description" role="status">{t(done().action === "pause" ? "settings.machines.paused.notice" : "settings.machines.resumed.notice", { name: props.name })}</p>}
      </Match>
      <Match when={props.state.kind === "failed" && props.state}>
        {(failed) => <p class="settings-note" data-tone="danger" role="alert">{t(FAILED_KEY[failed().action], { name: props.name, reason: errorCopy(failed().error).title })}</p>}
      </Match>
    </Switch>
  )
}

export function MachineActions(props: { readonly machine: Machine; readonly enrollment: MachineEnrollment; readonly onChanged: () => void }) {
  const t = useTranslator(settingsDictionary)
  const server = useServer()
  const dialog = useDialog()
  const actions = machineActions()
  const name = () => props.machine.name
  const busy = () => actions.state().kind === "working"
  const run = async (action: MachineAction) => {
    const removed = name()
    actions.send({ type: "started", action })
    try {
      await server.machines[action](props.enrollment)
    } catch (error) {
      return actions.send({ type: "failed", error: toAppError(error) })
    }
    actions.send({ type: "succeeded" })
    if (action !== "remove") return props.onChanged()
    showToast({ title: t("settings.machines.removed.notice", { name: removed }) })
    dialog.close()
  }
  const remove = async () => {
    const confirmed = await requestConfirm(dialog, { title: t("settings.machines.remove.confirm", { name: name() }), body: t("settings.machines.remove.body"), confirmLabel: t("settings.common.remove"), cancelLabel: t("settings.common.cancel"), destructive: true })
    if (confirmed) await run("remove")
  }
  return (
    <div class="settings-fields settings-machine-actions">
      <Show
        when={props.machine.paused}
        fallback={<ActionRow title={t("settings.machines.pause.title", { name: name() })} description={t("settings.machines.pause.description")} label={t("settings.machines.pause")} busy={busy()} onPress={() => void run("pause")} />}
      >
        <ActionRow title={t("settings.machines.resume.title", { name: name() })} description={t("settings.machines.resume.description")} label={t("settings.machines.resume")} busy={busy()} onPress={() => void run("resume")} />
      </Show>
      <ActionNotice state={actions.state()} name={name()} />
      <ActionRow title={t("settings.machines.remove.title", { name: name() })} description={t("settings.machines.remove.description")} label={t("settings.common.remove")} danger busy={busy()} onPress={() => void remove()} />
    </div>
  )
}
