import { Show, type Component } from "solid-js"
import { createFlow, runFlow } from "@/lib/flow"
import { toAppError, type AppError, type ProjectId } from "@/server"
import { Dialog, useDialog, Button, DialogBody, DialogHeader, DialogTitle } from "@/ui"
import { useProjectsText, type ProjectsText } from "../i18n"
import { useProjectCommands } from "../store"

function removalMessage(t: ProjectsText, error: AppError): string {
  return error.class === "conflict" ? `${error.message} ${t("projects.remove.cloudFirst")}` : error.message
}

export const RemoveProjectDialog: Component<{ id: ProjectId; name: string; onRemoved: () => void }> = (props) => {
  const t = useProjectsText()
  const dialog = useDialog()
  const commands = useProjectCommands()
  const removal = createFlow<"removing", void>()
  const removing = () => removal.state().kind === "running"
  const failure = () => {
    const state = removal.state()
    return state.kind === "failed" ? removalMessage(t, state.error) : undefined
  }

  const remove = async () => {
    if (removing()) return
    await runFlow(removal, "removing", () => commands.remove(props.id), toAppError)
    if (removal.state().kind !== "done") return
    dialog.close()
    props.onRemoved()
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitle>{t("projects.remove.title")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="flex min-w-[340px] max-w-[440px] flex-col gap-4 px-4 pb-4">
        <p class="whitespace-pre-line text-13-regular text-text-weak">{t("projects.remove.confirm", { name: props.name })}</p>
        <Show when={failure()}>
          {(message) => (
            <p class="projects-alert m-0" role="alert" data-testid="remove-project-failure">
              {message()}
            </p>
          )}
        </Show>
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => dialog.close()}>
            {t("projects.cancel")}
          </Button>
          <Button type="button" variant="contrast" disabled={removing()} onClick={() => void remove()}>
            {t("projects.remove")}
          </Button>
        </div>
      </DialogBody>
    </Dialog>
  )
}
