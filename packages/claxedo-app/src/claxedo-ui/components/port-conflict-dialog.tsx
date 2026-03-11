/**
 * Port Conflict Dialog
 *
 * Shown when a process has a preferred port that is already occupied.
 * Displays info about the occupier and lets the user choose:
 * - "Kill & take port" — kill the occupying process and use the preferred port
 * - "Pick new port" — scan upward to the next free port for this workspace
 */

import { Show } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import type { Process } from "../../opencode-patches/process/process"

export type PortConflictDialogProps = {
  conflict: Process.PortConflictInfo
  configId: string
  onResolve: (strategy: "kill-existing" | "pick-new") => void
  onCancel: () => void
}

export function PortConflictDialog(props: PortConflictDialogProps) {
  const conflict = () => props.conflict

  return (
    <Dialog title="Port occupied" class="w-full max-w-[420px] mx-auto">
      <div class="flex flex-col gap-4 px-6 pb-2">
        <div class="flex flex-col gap-2">
          <p class="text-13-regular text-text-base">
            Port <span class="font-mono font-semibold text-text-strong">{conflict().port}</span> is
            already in use.
          </p>

          <div class="rounded-md border border-border-weak-base bg-surface-inset px-3 py-2.5 flex flex-col gap-1.5">
            <Show when={conflict().processName}>
              <div class="flex items-center gap-2 text-12-regular">
                <span class="text-text-weak shrink-0">Process:</span>
                <span class="font-mono text-text-strong truncate">{conflict().processName}</span>
              </div>
            </Show>
            <Show when={conflict().directory}>
              <div class="flex items-center gap-2 text-12-regular">
                <span class="text-text-weak shrink-0">Workspace:</span>
                <span class="font-mono text-text-strong truncate text-[11px]">{conflict().directory}</span>
              </div>
            </Show>
            <Show when={conflict().pid}>
              <div class="flex items-center gap-2 text-12-regular">
                <span class="text-text-weak shrink-0">PID:</span>
                <span class="font-mono text-text-strong">{conflict().pid}</span>
              </div>
            </Show>
            <Show when={conflict().command}>
              <div class="flex items-center gap-2 text-12-regular">
                <span class="text-text-weak shrink-0">Command:</span>
                <span class="font-mono text-text-strong truncate text-[11px]">{conflict().command}</span>
              </div>
            </Show>
          </div>
        </div>
      </div>

      <div class="flex items-center gap-2 px-6 py-3 border-t border-border-weak-base">
        <Button type="button" variant="ghost" size="large" onClick={props.onCancel}>
          Cancel
        </Button>
        <div class="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="large"
          onClick={() => props.onResolve("pick-new")}
        >
          Pick new port
        </Button>
        <Button
          type="button"
          variant="primary"
          size="large"
          class="!bg-red-600 hover:!bg-red-700"
          onClick={() => props.onResolve("kill-existing")}
        >
          Kill &amp; take port
        </Button>
      </div>
    </Dialog>
  )
}
