import { createEffect, on, type Component } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { UsageDashboard } from "@/features/usage/ui/usage-dashboard"
import { useClaxedoEventsOptional } from "@/app/integrations/claxedo-events"

/**
 * The control-plane news the Usage-limits view re-reads on: the quota doorbell
 * itself, and every way a doorbell can be missed — a stream that came back
 * with the level down, one that came back while a sibling held it up, and a
 * hole in the replay.
 */
function useQuotaChanges() {
  const events = useClaxedoEventsOptional()
  if (!events) return undefined
  return (notify: () => void) => {
    createEffect(on(events.centralConnected, (connected, was) => {
      if (connected && was === false) notify()
    }, { defer: true }))
    createEffect(on(events.controlPlaneReconnects, notify, { defer: true }))
    const stopRing = events.on("usage.quota.changed", notify)
    const stopGap = events.listen((frame) => {
      if (frame.type === "stream.replay-gap" && frame.stream === "cp") notify()
    })
    return () => {
      stopRing()
      stopGap()
    }
  }
}

export const DialogUsage: Component = () => {
  const dialog = useDialog()
  const quotaChanges = useQuotaChanges()
  return (
    <Dialog
      size="x-large"
      transition
      flush
      class="flex-1 workspace-page-dialog workspace-page-dialog-shell settings-dialog-shell usage-dialog-shell"
      aria-label="Usage"
      onEscapeKeyDown={() => dialog.close()}
    >
      <div class="workspace-page-mobile-header usage-dialog-mobile-header">
        <span>Usage</span>
        <button type="button" aria-label="Close usage" onClick={() => dialog.close()}><Icon name="close" size="small" /></button>
      </div>
      <UsageDashboard quotaChanges={quotaChanges} />
    </Dialog>
  )
}
