import { Show, type Component } from "solid-js"
import { createFlow, runFlow } from "@/lib/flow"
import { toAppError, type AppError, type Project } from "@/server"
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup, useDialog } from "@/ui"
import { useProjectsText, type ProjectsText } from "../i18n"
import { useProjectCommands } from "../store"

function removalMessage(t: ProjectsText, error: AppError): string {
  return error.class === "conflict" ? `${error.message} ${t("projects.remove.cloudFirst")}` : error.message
}

export const RemoveProjectDialog: Component<{ project: Project; onRemoved: () => void }> = (props) => {
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
    await runFlow(removal, "removing", () => commands.remove(props.project.id), toAppError)
    if (removal.state().kind !== "done") return
    dialog.close()
    props.onRemoved()
  }

  return (
    <Dialog>
      <DialogHeader closeLabel={t("projects.close")}>
        <DialogTitleGroup title={t("projects.remove.title")} description={t("projects.remove.confirm", { name: props.project.name })} />
      </DialogHeader>
      <Show when={failure()}>
        {(message) => (
          <DialogBody>
            <p class="projects-alert m-0" role="alert" data-testid="remove-project-failure">
              {message()}
            </p>
          </DialogBody>
        )}
      </Show>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => dialog.close()}>
          {t("projects.cancel")}
        </Button>
        <Button type="button" variant="danger" disabled={removing()} onClick={() => void remove()}>
          {t("projects.remove")}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
