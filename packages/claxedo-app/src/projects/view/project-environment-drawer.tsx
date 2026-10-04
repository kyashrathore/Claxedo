import { createSignal, type JSX } from "solid-js"
import { toAppError, useServer, type Project } from "@/server"
import { Field, FormDrawer, Textarea, useDialog } from "@/ui"
import { useProjectsText } from "../i18n"
import { EnvironmentEditor, environmentRecord, environmentRows, environmentRowsProblem } from "./environment-editor"

export function DrawerProjectEnvironment(props: { readonly project: Project }): JSX.Element {
  const t = useProjectsText()
  const server = useServer()
  const dialog = useDialog()
  const [startup, setStartup] = createSignal(props.project.commands?.start ?? "")
  const [rows, setRows] = createSignal(environmentRows(props.project.env))
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const save = async () => {
    setSaving(true)
    setError(undefined)
    try {
      await server.projects.update(props.project.id, { env: environmentRecord(rows()), commands: { start: startup().trim() } })
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
      <Field>
        <Field.Label>{t("projects.edit.startup")}</Field.Label>
        <Field.Prefix>{t("projects.edit.startup.description")}</Field.Prefix>
        <Textarea
          class="textarea-v2--full-width"
          style={{ "font-family": "var(--font-family-mono)" }}
          placeholder="bun install"
          value={startup()}
          onInput={(event) => setStartup(event.currentTarget.value)}
          spellcheck={false}
        />
      </Field>
      <div class="flex flex-col gap-2">
        <div class="flex flex-col gap-0.5">
          <span class="text-13-medium text-text-strong">{t("projects.edit.environment")}</span>
          <span class="text-12-regular text-text-weak">{t("projects.edit.environment.description")}</span>
        </div>
        <EnvironmentEditor rows={rows()} onChange={setRows} />
      </div>
    </FormDrawer>
  )
}
