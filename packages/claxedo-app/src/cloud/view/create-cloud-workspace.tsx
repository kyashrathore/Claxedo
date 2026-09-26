import { createSignal, Show, type Component } from "solid-js"
import { createFlow, runFlow } from "@/lib/flow"
import { toAppError, type CloudWorkspace } from "@/server"
import { Button, TextField } from "@/ui"
import { useCloudText } from "../i18n"
import type { CloudWorkspaces } from "../store"

export const CreateCloudWorkspace: Component<{ cloud: CloudWorkspaces }> = (props) => {
  const t = useCloudText()
  const [name, setName] = createSignal("")
  const [branch, setBranch] = createSignal("")
  const creation = createFlow<"creating", CloudWorkspace>()
  const creating = () => creation.state().kind === "running"
  const failure = () => {
    const state = creation.state()
    return state.kind === "failed" ? state.error.message : undefined
  }

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (creating()) return
    const input = { ...(name().trim() ? { name: name().trim() } : {}), ...(branch().trim() ? { branch: branch().trim() } : {}) }
    await runFlow(creation, "creating", () => props.cloud.create(input), toAppError)
    if (creation.state().kind !== "done") return
    setName("")
    setBranch("")
  }

  return (
    <form class="flex flex-col gap-2" onSubmit={(event) => void submit(event)} data-testid="create-cloud-workspace">
      <div class="flex flex-wrap gap-2">
        <TextField
          class="min-w-0 flex-1"
          value={name()}
          placeholder={t("cloud.create.name")}
          label={t("cloud.create.name")}
          hideLabel
          onChange={setName}
        />
        <TextField
          class="min-w-0 flex-1"
          value={branch()}
          placeholder={t("cloud.create.branch")}
          label={t("cloud.create.branch")}
          hideLabel
          spellcheck={false}
          onChange={setBranch}
        />
        <Button type="submit" variant="contrast" disabled={creating()}>
          {creating() ? t("cloud.creating") : t("cloud.new")}
        </Button>
      </div>
      <Show when={failure()}>
        {(reason) => (
          <p class="cloud-alert m-0" role="alert" data-testid="cloud-create-failure">
            {t("cloud.create.failed")}: {reason()}
          </p>
        )}
      </Show>
    </form>
  )
}
