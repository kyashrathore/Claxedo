import { createSignal, Show, type Component } from "solid-js"
import type { AppError, Project } from "@/server"
import { appErrorOf } from "../api"
import { projectsText } from "../i18n"
import { useProjectCommands } from "../store"
import { buttonAttrs } from "./button-attrs"
import { Modal } from "./modal"

function removalMessage(error: AppError): string {
  return error.class === "conflict" ? `${error.message} ${projectsText("projects.remove.cloudFirst")}` : error.message
}

export const RemoveProjectDialog: Component<{
  project: Project | undefined
  onClose: () => void
  onRemoved: (project: Project) => void
}> = (props) => {
  const commands = useProjectCommands()
  const [removing, setRemoving] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()

  const remove = async () => {
    const project = props.project
    if (!project || removing()) return
    setRemoving(true)
    setFailure(undefined)
    try {
      await commands.remove(project.id)
      props.onRemoved(project)
      props.onClose()
    } catch (cause) {
      setFailure(removalMessage(appErrorOf(cause)))
    } finally {
      setRemoving(false)
    }
  }

  return (
    <Modal open={props.project !== undefined} title={projectsText("projects.remove.title")} onClose={props.onClose}>
      <Show when={props.project}>
        {(project) => (
          <div class="flex flex-col gap-4" data-testid="remove-project">
            <p class="m-0 text-sm">{projectsText("projects.remove.confirm", { name: project().name })}</p>
            <Show when={failure()}>
              {(message) => (
                <p class="projects-alert" role="alert">
                  {message()}
                </p>
              )}
            </Show>
            <div class="flex justify-end gap-2">
              <button type="button" {...buttonAttrs("ghost")} onClick={props.onClose}>
                {projectsText("projects.cancel")}
              </button>
              <button type="button" {...buttonAttrs("danger")} disabled={removing()} onClick={() => void remove()}>
                {projectsText("projects.remove")}
              </button>
            </div>
          </div>
        )}
      </Show>
    </Modal>
  )
}
