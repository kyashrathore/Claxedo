import { createSignal, Match, Switch } from "solid-js"
import { useErrorCopy, useTranslator } from "@/i18n"
import { toAppError, useServer, type MachineEnrollment } from "@/server"
import { Button, TextField } from "@/ui"
import { settingsDictionary } from "../i18n"
import { machineActions, type ActionState } from "../machines"

type RenameAction = "rename"

function RenameNotice(props: { readonly state: ActionState<RenameAction>; readonly name: string }) {
  const t = useTranslator(settingsDictionary)
  const errorCopy = useErrorCopy("machines")
  return (
    <Switch>
      <Match when={props.state.kind === "done"}>
        <p class="settings-row-description" role="status">{t("settings.machines.renamed.notice", { name: props.name })}</p>
      </Match>
      <Match when={props.state.kind === "failed" && props.state}>
        {(failed) => <p class="settings-note" data-tone="danger" role="alert">{t("settings.machines.rename.failed", { name: props.name, reason: errorCopy(failed().error).title })}</p>}
      </Match>
    </Switch>
  )
}

export function RenameMachine(props: { readonly name: string; readonly enrollment: MachineEnrollment }) {
  const t = useTranslator(settingsDictionary)
  const server = useServer()
  const actions = machineActions<RenameAction>()
  const [draft, setDraft] = createSignal(props.name)
  const next = () => draft().trim()
  const unchanged = () => next() === "" || next() === props.name || actions.state().kind === "working"
  const rename = async () => {
    if (unchanged()) return
    actions.send({ type: "started", action: "rename" })
    try {
      await server.machines.rename(props.enrollment, next())
    } catch (error) {
      return actions.send({ type: "failed", error: toAppError(error) })
    }
    actions.send({ type: "succeeded" })
  }
  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    void rename()
  }
  return (
    <form class="settings-fields" onSubmit={submit}>
      <div class="settings-inline settings-machine-rename">
        <TextField class="settings-machine-name" label={t("settings.machines.rename.title")} value={draft()} onChange={setDraft} autocomplete="off" maxLength={120} />
        <Button type="submit" size="small" variant="neutral" disabled={unchanged()}>{t("settings.machines.rename")}</Button>
      </div>
      <RenameNotice state={actions.state()} name={props.name} />
    </form>
  )
}
