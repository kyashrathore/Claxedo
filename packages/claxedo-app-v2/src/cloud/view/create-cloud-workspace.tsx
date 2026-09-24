import { createSignal, Show, type Component } from "solid-js"
import { Button, TextInput } from "@/ui"
import { failureReason } from "../api"
import { useCloudText } from "../i18n"
import type { CloudWorkspaces } from "../store"

export const CreateCloudWorkspace: Component<{ cloud: CloudWorkspaces }> = (props) => {
  const t = useCloudText()
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
      await props.cloud.create({
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
        <TextInput
          class="min-w-0 flex-1"
          value={name()}
          placeholder={t("cloud.create.name")}
          aria-label={t("cloud.create.name")}
          onInput={(event) => setName(event.currentTarget.value)}
        />
        <TextInput
          class="min-w-0 flex-1"
          value={branch()}
          placeholder={t("cloud.create.branch")}
          aria-label={t("cloud.create.branch")}
          spellcheck={false}
          onInput={(event) => setBranch(event.currentTarget.value)}
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
