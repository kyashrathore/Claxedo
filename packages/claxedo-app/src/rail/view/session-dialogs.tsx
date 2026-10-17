import { createSignal, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { createFlow, runFlow } from "@/lib/flow"
import { toAppError } from "@/server"
import { FormDialog, TextField, useDialog } from "@/ui"
import { railDictionary } from "../i18n"

export function RenameSessionDialog(props: { readonly title: string; readonly onSubmit: (title: string) => Promise<void> }): JSX.Element {
  const t = useTranslator(railDictionary)
  const dialog = useDialog()
  const [title, setTitle] = createSignal(props.title)
  const renaming = createFlow<"renaming", void>()
  const error = () => {
    const state = renaming.state()
    return state.kind === "failed" ? t("rail.renameFailed", { reason: state.error.message }) : undefined
  }
  const submit = async () => {
    await runFlow(renaming, "renaming", () => props.onSubmit(title().trim()), toAppError)
    if (renaming.state().kind === "done") dialog.close()
  }
  return (
    <FormDialog
      title={t("rail.rename")}
      submitLabel={t("rail.save")}
      busyLabel={t("rail.saving")}
      cancelLabel={t("rail.cancel")}
      busy={renaming.state().kind === "running"}
      canSubmit={title().trim().length > 0}
      error={error()}
      onSubmit={() => void submit()}
      onCancel={() => dialog.close()}
    >
      <TextField label={t("rail.renameLabel")} value={title()} onChange={setTitle} autofocus />
    </FormDialog>
  )
}
