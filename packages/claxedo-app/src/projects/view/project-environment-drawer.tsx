import { createSignal, type JSX } from "solid-js"
import { toAppError, useServer, type Project } from "@/server"
import { FormDrawer, useDialog } from "@/ui"
import { useProjectsText } from "../i18n"
import { EnvironmentEditor, environmentChanges, environmentProblem, environmentRows, markStored, type EnvironmentChanges } from "./environment-editor"

export function DrawerProjectEnvironment(props: { readonly project: Project; readonly names: readonly string[] }): JSX.Element {
  const t = useProjectsText()
  const server = useServer()
  const dialog = useDialog()
  const [rows, setRows] = createSignal(environmentRows(props.names))
  const [stored, setStored] = createSignal(props.names)
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const apply = async (changes: EnvironmentChanges, saved: string[]) => {
    for (const name of changes.remove) {
      setStored((await server.projects.removeVariable(props.project.id, name)).names)
      saved.push(name)
    }
    for (const [name, value] of changes.set) {
      setStored((await server.projects.setVariable(props.project.id, name, value)).names)
      setRows((current) => markStored(current, name))
      saved.push(name)
    }
  }
  const save = async () => {
    const saved: string[] = []
    setSaving(true)
    setError(undefined)
    try {
      await apply(environmentChanges(stored(), rows()), saved)
      dialog.close()
    } catch (cause) {
      const reason = toAppError(cause).message
      setError(saved.length > 0 ? t("projects.environment.partial", { saved: saved.join(", "), reason }) : reason)
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
