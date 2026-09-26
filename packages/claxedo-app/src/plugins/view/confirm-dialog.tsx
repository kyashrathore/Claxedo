import type { JSX } from "solid-js"
import type { Confirmation } from "@claxedo/plugin-api"
import { Show } from "solid-js"
import { Dialog, type useDialog, Button, DialogBody, DialogHeader, DialogTitle } from "@/ui"
import { usePluginsText } from "../i18n"

type Dialogs = ReturnType<typeof useDialog>

function ConfirmDialog(props: { readonly confirmation: Confirmation; readonly decide: (confirmed: boolean) => void }): JSX.Element {
  const t = usePluginsText()
  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitle>{props.confirmation.title}</DialogTitle>
      </DialogHeader>
      <DialogBody class="flex min-w-[340px] max-w-[440px] flex-col gap-4 px-4 pb-4">
        <Show when={props.confirmation.description}>
          {(description) => <p class="whitespace-pre-line text-13-regular text-text-weak">{description()}</p>}
        </Show>
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => props.decide(false)}>
            {props.confirmation.cancelLabel ?? t("plugins.cancel")}
          </Button>
          <Button type="button" variant="contrast" onClick={() => props.decide(true)}>
            {props.confirmation.confirmLabel ?? t("plugins.confirm")}
          </Button>
        </div>
      </DialogBody>
    </Dialog>
  )
}

export function confirmThrough(dialog: Dialogs, confirmation: Confirmation): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false
    const answer = (confirmed: boolean) => {
      if (answered) return
      answered = true
      resolve(confirmed)
    }
    const decide = (confirmed: boolean) => {
      answer(confirmed)
      dialog.close()
    }
    void dialog.show(() => <ConfirmDialog confirmation={confirmation} decide={decide} />, () => answer(false))
  })
}
