import type { Component } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { UsageDashboard } from "@/features/usage/ui/usage-dashboard"

export const DialogUsage: Component = () => {
  const dialog = useDialog()
  return (
    <Dialog size="x-large" transition flush class="flex-1 settings-dialog-shell usage-dialog-shell" aria-label="Usage">
      <div class="usage-dialog-mobile-header">
        <span>Usage</span>
        <button type="button" aria-label="Close usage" onClick={() => dialog.close()}><Icon name="close" size="small" /></button>
      </div>
      <UsageDashboard />
    </Dialog>
  )
}
