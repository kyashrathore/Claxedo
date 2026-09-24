import { createSignal, Show, type Component } from "solid-js"
import type { ProjectId } from "@/server"
import { failureReason } from "../api"
import { cloudText } from "../i18n"
import { useCloud } from "../store"
import { buttonAttrs } from "./button-attrs"

export const CreateCloudWorkspace: Component<{ projectId: ProjectId }> = (props) => {
  const cloud = useCloud()
  const [name, setName] = createSignal("")
  const [branch, setBranch] = createSignal("")
  const [creating, setCreating] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (creating()) return
    setCreating(true)
    setFailure(undefined)
    try {
      await cloud.create({
        projectId: props.projectId,
        ...(name().trim() ? { name: name().trim() } : {}),
        ...(branch().trim() ? { branch: branch().trim() } : {}),
      })
      setName("")
      setBranch("")
    } catch (cause) {
      setFailure(failureReason(cause))
    } finally {
      setCreating(false)
    }
  }

  return (
    <form class="flex flex-col gap-2" onSubmit={(event) => void submit(event)} data-testid="create-cloud-workspace">
      <div class="flex flex-wrap gap-2">
        <input
          type="text"
          class="cloud-field flex-1"
          value={name()}
          placeholder={cloudText("cloud.create.name")}
          aria-label={cloudText("cloud.create.name")}
          onInput={(event) => setName(event.currentTarget.value)}
        />
        <input
          type="text"
          class="cloud-field flex-1"
          value={branch()}
          placeholder={cloudText("cloud.create.branch")}
          aria-label={cloudText("cloud.create.branch")}
          spellcheck={false}
          onInput={(event) => setBranch(event.currentTarget.value)}
        />
        <button type="submit" {...buttonAttrs("contrast")} disabled={creating()}>
          {creating() ? cloudText("cloud.creating") : cloudText("cloud.new")}
        </button>
      </div>
      <Show when={failure()}>
        {(reason) => (
          <p class="cloud-alert m-0" role="alert">
            {cloudText("cloud.create.failed")}: {reason()}
          </p>
        )}
      </Show>
    </form>
  )
}
