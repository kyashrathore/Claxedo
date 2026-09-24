import { createSignal, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { failureMessage } from "@/lib/failure"
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle, showToast, TextInput, useDialog } from "@/ui"
import { dictionary } from "../i18n"

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
  const t = useTranslator(dictionary)
  const [title, setTitle] = createSignal(props.title)
  const form = useSubmit(() => props.onSubmit(title().trim()), () => t("rail.renameFailed"))
  return (
    <Dialog>
      <DialogHeader closeLabel={t("rail.cancel")}>
        <DialogTitle>{t("rail.rename")}</DialogTitle>
      </DialogHeader>
      <form onSubmit={(event) => void form.submit(event)}>
        <DialogBody>
          <TextInput aria-label={t("rail.renameLabel")} value={title()} onInput={(event) => setTitle(event.currentTarget.value)} autofocus />
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={form.cancel}>
            {t("rail.cancel")}
          </Button>
          <Button type="submit" disabled={form.busy() || title().trim().length === 0}>
            {t("rail.save")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  )
}

export function DeleteSessionDialog(props: { readonly title: string; readonly onConfirm: () => Promise<void> }): JSX.Element {
  const t = useTranslator(dictionary)
  const form = useSubmit(props.onConfirm, () => t("rail.deleteFailed"))
  return (
    <Dialog>
      <DialogHeader closeLabel={t("rail.cancel")}>
        <DialogTitle>{t("rail.deleteTitle")}</DialogTitle>
      </DialogHeader>
      <form onSubmit={(event) => void form.submit(event)}>
        <DialogBody>
          <p>{t("rail.deleteConfirm", { name: props.title })}</p>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={form.cancel}>
            {t("rail.cancel")}
          </Button>
          <Button type="submit" variant="danger" disabled={form.busy()}>
            {t("rail.deleteButton")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  )
}
