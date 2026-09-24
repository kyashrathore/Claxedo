import type { JSX } from "solid-js"
import type { Confirmation } from "@claxedo/plugin-api"
import { Button, Dialog, DialogFooter, DialogHeader, DialogTitleGroup, type useDialog } from "@/ui"
import { usePluginsText } from "../i18n"

type Dialogs = ReturnType<typeof useDialog>

function ConfirmDialog(props: { readonly confirmation: Confirmation; readonly decide: (confirmed: boolean) => void }): JSX.Element {
  const t = usePluginsText()
  return (
    <Dialog>
      <DialogHeader closeLabel={t("plugins.close")}>
        <DialogTitleGroup title={props.confirmation.title} description={props.confirmation.description ?? ""} />
      </DialogHeader>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => props.decide(false)}>
          {props.confirmation.cancelLabel ?? t("plugins.cancel")}
        </Button>
        <Button type="button" variant={props.confirmation.destructive ? "danger" : "neutral"} onClick={() => props.decide(true)}>
          {props.confirmation.confirmLabel ?? t("plugins.confirm")}
        </Button>
      </DialogFooter>
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
