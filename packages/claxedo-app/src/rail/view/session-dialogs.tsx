import { createSignal, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { failureMessage } from "@/lib/failure"
import { Dialog, showToast, useDialog, TextField, Button, DialogBody, DialogHeader, DialogTitle } from "@/ui"
import { railDictionary } from "../i18n"

function useSubmit(run: () => Promise<void>, failureTitle: () => string) {
  const dialog = useDialog()
  const [busy, setBusy] = createSignal(false)
  const submit = async (event: Event) => {
    event.preventDefault()
    setBusy(true)
    try {
      await run()
      dialog.close()
    } catch (error) {
      showToast({ title: failureTitle(), description: failureMessage(error) })
    } finally {
      setBusy(false)
    }
  }
  return { busy, submit, cancel: () => dialog.close() }
}

export function RenameSessionDialog(props: { readonly title: string; readonly onSubmit: (title: string) => Promise<void> }): JSX.Element {
  const t = useTranslator(railDictionary)
  const [title, setTitle] = createSignal(props.title)
  const form = useSubmit(() => props.onSubmit(title().trim()), () => t("rail.renameFailed"))
  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitle>{t("rail.rename")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="px-4 pb-4">
      <form class="flex min-w-[340px] flex-col gap-4" onSubmit={(event) => void form.submit(event)}>
        <TextField label={t("rail.renameLabel")} hideLabel value={title()} onChange={setTitle} autofocus />
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="large" onClick={form.cancel}>
            {t("rail.cancel")}
          </Button>
          <Button type="submit" variant="contrast" size="large" disabled={form.busy() || title().trim().length === 0}>
            {t("rail.save")}
          </Button>
        </div>
      </form>
      </DialogBody>
    </Dialog>
  )
}
