import { createSignal, Show, type Component } from "solid-js"
import { createFlow, runFlow } from "@/lib/flow"
import { toAppError, type Project } from "@/server"
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle, Field, TextInput, useDialog } from "@/ui"
import { useProjectsText } from "../i18n"
import { useProjectCommands } from "../store"

export const RenameProjectDialog: Component<{ project: Project }> = (props) => {
  const t = useProjectsText()
  const dialog = useDialog()
  const commands = useProjectCommands()
  const [name, setName] = createSignal(props.project.name)
  const save = createFlow<"saving", Project>()
  const saving = () => save.state().kind === "running"
  const failure = () => {
    const state = save.state()
    return state.kind === "failed" ? state.error.message : undefined
  }

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    const next = name().trim()
    if (!next || saving()) return
    await runFlow(save, "saving", () => commands.rename(props.project.id, next), toAppError)
    if (save.state().kind === "done") dialog.close()
  }

  return (
    <Dialog fit>
      <DialogHeader closeLabel={t("projects.close")}>
        <DialogTitle>{t("projects.rename.title")}</DialogTitle>
      </DialogHeader>
      <form onSubmit={(event) => void submit(event)} data-testid="rename-project">
        <DialogBody class="flex flex-col gap-3 px-4">
          <Field>
            <Field.Label>{t("projects.rename.name")}</Field.Label>
            <Field.Control>
              <TextInput value={name()} autofocus onInput={(event) => setName(event.currentTarget.value)} />
            </Field.Control>
          </Field>
          <Show when={failure()}>
            {(message) => (
              <p class="projects-alert m-0" role="alert">
                {message()}
              </p>
            )}
          </Show>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => dialog.close()}>
            {t("projects.cancel")}
          </Button>
          <Button type="submit" variant="contrast" disabled={saving() || !name().trim()}>
            {saving() ? t("projects.saving") : t("projects.save")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  )
}
