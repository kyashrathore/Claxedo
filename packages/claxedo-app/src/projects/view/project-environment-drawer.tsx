import { createSignal, type JSX } from "solid-js"
import { toAppError, useServer, type Project } from "@/server"
import { FormDrawer, useDialog } from "@/ui"
import { useProjectsText } from "../i18n"
import { EnvironmentEditor, environmentChanges, environmentProblem, environmentRows } from "./environment-editor"

export function DrawerProjectEnvironment(props: { readonly project: Project; readonly names: readonly string[] }): JSX.Element {
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
