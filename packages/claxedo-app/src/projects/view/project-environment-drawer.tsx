import { createSignal, For, Show, type JSX } from "solid-js"
import { toAppError, useServer, type Project, type ProjectEnvironment } from "@/server"
import { Drawer, FormDrawer, useDialog } from "@/ui"
import { useProjectsText } from "../i18n"
import { EnvironmentEditor, environmentChanges, environmentProblem, environmentRows } from "./environment-editor"

function EnvironmentNames(props: { readonly names: readonly string[] }): JSX.Element {
  const t = useProjectsText()
  return (
    <ul class="flex flex-col gap-1.5 m-0 p-0 list-none" aria-label={t("projects.environment.label")}>
      <For each={props.names}>
        {(name) => (
          <li class="flex items-center justify-between gap-3">
            <span class="font-mono text-13-regular text-text-strong truncate">{name}</span>
            <span class="text-12-regular text-text-weak">{t("projects.environment.set")}</span>
          </li>
        )}
      </For>
    </ul>
  )
}

function EditableEnvironment(props: { readonly project: Project; readonly names: readonly string[] }): JSX.Element {
  const t = useProjectsText()
  const server = useServer()
  const dialog = useDialog()
  const [rows, setRows] = createSignal(environmentRows(props.names))
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const save = async () => {
    const changes = environmentChanges(props.names, rows())
    setSaving(true)
    setError(undefined)
    try {
      for (const name of changes.remove) await server.projects.removeVariable(props.project.id, name)
      for (const [name, value] of changes.set) await server.projects.setVariable(props.project.id, name, value)
      dialog.close()
    } catch (cause) {
      setError(toAppError(cause).message)
    } finally {
      setSaving(false)
    }
  }
  return (
    <FormDrawer
      title={t("projects.environment.title")}
      description={t("projects.environment.description")}
      submitLabel={t("projects.save")}
      busyLabel={t("projects.saving")}
      cancelLabel={t("projects.cancel")}
      busy={saving()}
      canSubmit={environmentProblem(rows()) === undefined}
      error={error()}
      onSubmit={() => void save()}
      onCancel={() => dialog.close()}
    >
      <EnvironmentEditor rows={rows()} onChange={setRows} />
    </FormDrawer>
  )
}

export function DrawerProjectEnvironment(props: { readonly project: Project; readonly environment: ProjectEnvironment }): JSX.Element {
  const t = useProjectsText()
  const dialog = useDialog()
  return (
    <Show
      when={props.environment.editable}
      fallback={
        <Drawer title={t("projects.environment.title")} description={t("projects.environment.readonly")} closeLabel={t("projects.environment.close")} onClose={() => dialog.close()}>
          <EnvironmentNames names={props.environment.names} />
        </Drawer>
      }
    >
      <EditableEnvironment project={props.project} names={props.environment.names} />
    </Show>
  )
}
