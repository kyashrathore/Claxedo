import { createSignal, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { failureMessage } from "@/lib/failure"
import { Button, Dialog, showToast, TextInput, useDialog } from "@/ui"
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
    <Dialog title={t("rail.rename")} fit>
      <form class="flex min-w-[340px] flex-col gap-4" onSubmit={(event) => void form.submit(event)}>
        <TextInput aria-label={t("rail.renameLabel")} value={title()} onInput={(event) => setTitle(event.currentTarget.value)} autofocus />
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={form.cancel}>
            {t("rail.cancel")}
          </Button>
          <Button type="submit" disabled={form.busy() || title().trim().length === 0}>
            {t("rail.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

export function DeleteSessionDialog(props: { readonly title: string; readonly onConfirm: () => Promise<void> }): JSX.Element {
  const t = useTranslator(dictionary)
  const form = useSubmit(props.onConfirm, () => t("rail.deleteFailed"))
  return (
    <Dialog title={t("rail.deleteTitle")} fit>
      <form class="flex flex-col gap-4" onSubmit={(event) => void form.submit(event)}>
        <div class="flex flex-col gap-1">
          <span class="text-14-regular text-text-strong">{t("rail.deleteConfirm", { name: props.title })}</span>
        </div>
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={form.cancel}>
            {t("rail.cancel")}
          </Button>
          <Button type="submit" variant="danger" disabled={form.busy()}>
            {t("rail.deleteButton")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
