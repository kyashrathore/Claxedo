import { createSignal, type JSX } from "solid-js"
import type { CloudWorkspaces } from "@/cloud"
import { createFlow, runFlow } from "@/lib/flow"
import { toAppError, type CloudWorkspace } from "@/server"
import { FormDialog, TextField, useDialog } from "@/ui"
import { useProjectsText } from "../i18n"

export function DialogNewCloudWorkspace(props: { readonly cloud: CloudWorkspaces; readonly onCreated?: (workspace: CloudWorkspace) => void }): JSX.Element {
  const t = useProjectsText()
  const dialog = useDialog()
  const [name, setName] = createSignal("")
  const [branch, setBranch] = createSignal("")
  const creation = createFlow<"creating", CloudWorkspace>()
  const failure = () => {
    const state = creation.state()
    return state.kind === "failed" ? state.error.message : undefined
  }
  const submit = async () => {
    const input = { name: name().trim(), ...(branch().trim() ? { branch: branch().trim() } : {}) }
    await runFlow(creation, "creating", () => props.cloud.create(input), toAppError)
    const state = creation.state()
    if (state.kind !== "done") return
    dialog.close()
    props.onCreated?.(state.result)
  }
  return (
    <FormDialog
      title={t("projects.where.new.title")}
      description={t("projects.where.new.description")}
      submitLabel={t("projects.where.new.submit")}
      busyLabel={t("projects.where.new.creating")}
      cancelLabel={t("projects.where.cancel")}
      busy={creation.state().kind === "running"}
      canSubmit={name().trim() !== ""}
      error={failure()}
      onSubmit={() => void submit()}
      onCancel={() => dialog.close()}
    >
      <TextField autofocus label={t("projects.where.new.name")} placeholder="checkout-flow" value={name()} onChange={setName} />
      <TextField label={t("projects.where.new.branch")} description={t("projects.where.new.branch.description")} placeholder="main" spellcheck={false} value={branch()} onChange={setBranch} />
    </FormDialog>
  )
}
