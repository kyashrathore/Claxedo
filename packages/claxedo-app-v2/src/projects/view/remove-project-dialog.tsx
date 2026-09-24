import { createSignal, Show, type Component } from "solid-js"
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
  const [removing, setRemoving] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()

  const remove = async () => {
    if (removing()) return
    setRemoving(true)
    setFailure(undefined)
    try {
      await commands.remove(props.project.id)
      dialog.close()
      props.onRemoved()
    } catch (cause) {
      setFailure(removalMessage(t, toAppError(cause)))
    } finally {
      setRemoving(false)
    }
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
