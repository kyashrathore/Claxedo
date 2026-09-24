import { createSignal, Show, type Component } from "solid-js"
import type { Project } from "@/server"
import { appErrorOf } from "../api"
import { projectsText } from "../i18n"
import { useProjectCommands } from "../store"
import { buttonAttrs } from "./button-attrs"
import { Modal } from "./modal"

export const RenameProjectDialog: Component<{ project: Project | undefined; onClose: () => void }> = (props) => {
  const commands = useProjectCommands()
  const [name, setName] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const open = () => props.project !== undefined

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    const project = props.project
    const next = name().trim()
    if (!project || !next || saving()) return
    setSaving(true)
    setFailure(undefined)
    try {
      await commands.rename(project.id, next)
      props.onClose()
    } catch (cause) {
      setFailure(appErrorOf(cause).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open()} title={projectsText("projects.rename.title")} onClose={props.onClose}>
      <Show when={props.project}>
        {(project) => (
          <form class="flex flex-col gap-4" onSubmit={(event) => void submit(event)} data-testid="rename-project">
            <label class="flex flex-col gap-1">
              <span class="projects-label">{projectsText("projects.rename.name")}</span>
              <input
                type="text"
                class="projects-field"
                value={name() || project().name}
                aria-label={projectsText("projects.rename.name")}
                onInput={(event) => setName(event.currentTarget.value)}
              />
            </label>
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
              <button type="submit" {...buttonAttrs("contrast")} disabled={saving() || !name().trim()}>
                {saving() ? projectsText("projects.saving") : projectsText("projects.save")}
              </button>
            </div>
          </form>
        )}
      </Show>
    </Modal>
  )
}
