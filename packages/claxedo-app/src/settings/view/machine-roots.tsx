import { For, Match, Show, Switch } from "solid-js"
import { useErrorCopy, useI18n, useTranslator } from "@/i18n"
import { toAppError, useServer, type MachineEnrollment, type MachineRoot } from "@/server"
import { Button, requestConfirm, useDialog } from "@/ui"
import { settingsDictionary } from "../i18n"
import { machineActions, rootsWithout, type ActionState } from "../machines"

function RootNotice(props: { readonly state: ActionState<string> }) {
  const t = useTranslator(settingsDictionary)
  const errorCopy = useErrorCopy("machines")
  return (
    <Switch>
      <Match when={props.state.kind === "done" && props.state}>
        {(done) => <p class="settings-row-description" role="status">{t("settings.machines.roots.removed.notice", { folder: done().action })}</p>}
      </Match>
      <Match when={props.state.kind === "failed" && props.state}>
        {(failed) => <p class="settings-note" data-tone="danger" role="alert">{t("settings.machines.roots.failed", { folder: failed().action, reason: errorCopy(failed().error).title })}</p>}
      </Match>
    </Switch>
  )
}

function RootRow(props: { readonly root: MachineRoot; readonly busy: boolean; readonly onRemove: () => void }) {
  const t = useTranslator(settingsDictionary)
  return (
    <li class="settings-inline settings-machine-action">
      <code class="settings-machine-root">{props.root.path}</code>
      <Button size="small" variant="ghost" aria-label={t("settings.machines.roots.remove.label", { folder: props.root.path })} disabled={props.busy} onClick={() => props.onRemove()}>
        {t("settings.machines.roots.remove")}
      </Button>
    </li>
  )
}

export function SharedFolders(props: { readonly name: string; readonly enrollment: MachineEnrollment; readonly roots: readonly MachineRoot[] }) {
  const t = useTranslator(settingsDictionary)
  const i18n = useI18n()
  const server = useServer()
  const dialog = useDialog()
  const actions = machineActions<string>()
  const retiring = (root: MachineRoot) => {
    if (root.retires.length === 0) return t("settings.machines.roots.retiresNothing", { name: props.name })
    const projects = new Intl.ListFormat(i18n.intlTag(), { type: "conjunction" }).format(root.retires.map((assignment) => assignment.name))
    return t("settings.machines.roots.retires", { projects, name: props.name })
  }
  const remove = async (root: MachineRoot) => {
    const confirmed = await requestConfirm(dialog, { title: t("settings.machines.roots.confirm", { folder: root.path }), body: retiring(root), confirmLabel: t("settings.machines.roots.remove"), cancelLabel: t("settings.common.cancel"), destructive: true })
    if (!confirmed) return
    actions.send({ type: "started", action: root.path })
    try {
      await server.machines.setRoots(props.enrollment, rootsWithout(props.roots, root.path))
    } catch (error) {
      return actions.send({ type: "failed", error: toAppError(error) })
    }
    actions.send({ type: "succeeded" })
  }
  return (
    <section class="settings-fields settings-machine-actions" aria-label={t("settings.machines.roots")}>
      <span class="settings-row-title">{t("settings.machines.roots")}</span>
      <Show when={props.roots.length > 0} fallback={<p class="settings-row-description">{t("settings.machines.roots.empty")}</p>}>
        <ul class="settings-machine-roots">
          <For each={props.roots}>{(root) => <RootRow root={root} busy={actions.state().kind === "working"} onRemove={() => void remove(root)} />}</For>
        </ul>
      </Show>
      <RootNotice state={actions.state()} />
    </section>
  )
}
