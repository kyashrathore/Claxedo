import { createSignal } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useLanguage } from "@/context/language"

export interface DialogRecoverWorkspaceProps {
  name: string
  onRecover: () => Promise<void>
  onClose: () => void
}

export function DialogRecoverWorkspace(props: DialogRecoverWorkspaceProps) {
  const language = useLanguage()
  const [loading, setLoading] = createSignal(false)

  const handleRecover = async () => {
    setLoading(true)
    try {
      await props.onRecover()
      props.onClose()
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog title="Worktree not found" fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <div class="flex flex-col gap-1">
          <span class="text-14-regular text-text-strong">
            The backing worktree for "{props.name}" is gone.
          </span>
          <span class="text-12-regular text-text-weak">
            You can keep browsing past sessions here, or continue in a new worktree for this project.
          </span>
        </div>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={props.onClose} disabled={loading()}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="primary" size="large" onClick={handleRecover} disabled={loading()}>
            {loading() ? language.t("common.loading") : "Continue in new worktree"}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
