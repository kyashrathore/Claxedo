import { createSignal } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useLanguage } from "@claxedo/context/language"
import type { Session } from "@opencode-ai/sdk/v2"

export interface DialogDeleteSessionProps {
  session: Session
  onDelete: (session: Session) => Promise<void>
  onClose: () => void
}

export function DialogDeleteSession(props: DialogDeleteSessionProps) {
  const language = useLanguage()
  const [deleting, setDeleting] = createSignal(false)

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await props.onDelete(props.session)
      props.onClose()
    } finally {
      setDeleting(false)
    }
  }

  // Note: 'fit' prop might require checking the Dialog component definition if it accepts it.
  // Assuming it does based on upstream usage.
  return (
    <Dialog title={language.t("session.delete.title")} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <div class="flex flex-col gap-1">
          <span class="text-14-regular text-text-strong">
            {language.t("session.delete.confirm", { name: props.session.title })}
          </span>
        </div>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={props.onClose} disabled={deleting()}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="primary" size="large" onClick={handleDelete} disabled={deleting()}>
            {deleting()
              ? language.t("common.loading")
              : language.t("session.delete.button")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
