import { createSignal, type JSX } from "solid-js"
import { toAppError, useServer, type Project } from "@/server"
import { FormDrawer, useDialog } from "@/ui"
import { useProjectsText } from "../i18n"
import { EnvironmentEditor, environmentRecord, environmentRows, environmentRowsProblem } from "./environment-editor"

export function DrawerProjectEnvironment(props: { readonly project: Project }): JSX.Element {
  const t = useProjectsText()
  const server = useServer()
  const dialog = useDialog()
  const [rows, setRows] = createSignal(environmentRows(props.project.env))
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const save = async () => {
    setSaving(true)
    setError(undefined)
    try {
      await server.projects.update(props.project.id, { env: environmentRecord(rows()) })
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
      canSubmit={environmentRowsProblem(rows()) === undefined}
      error={error()}
      onSubmit={() => void save()}
      onCancel={() => dialog.close()}
    >
      <EnvironmentEditor rows={rows()} onChange={setRows} />
    </FormDrawer>
  )
}
