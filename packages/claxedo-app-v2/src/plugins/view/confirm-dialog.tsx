import type { JSX } from "solid-js"
import type { Confirmation } from "@claxedo/plugin-api"
import { Button, Dialog, DialogFooter, DialogHeader, DialogTitleGroup } from "@/ui"
import { usePluginsText } from "../i18n"

export function ConfirmDialog(props: { readonly confirmation: Confirmation; readonly decide: (confirmed: boolean) => void }): JSX.Element {
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
