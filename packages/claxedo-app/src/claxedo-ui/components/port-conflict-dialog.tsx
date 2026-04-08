/**
 * Port Conflict Dialog
 *
 * Shown when a process has a preferred port that is already occupied.
 * Displays info about the occupier and lets the user choose:
 * - "Pick new port" — scan upward to the next free port for this workspace
 * - "Kill & reclaim" — kill the occupying process and use the preferred port
 */

import { Show, createSignal } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import type { Process } from "@claxedo/process/process"

export type PortConflictDialogProps = {
  conflict: Process.PortConflictInfo
  configId: string
  onResolve: (strategy: "kill-existing" | "pick-new") => void
  onCancel: () => void
}

export function PortConflictDialog(props: PortConflictDialogProps) {
  const conflict = () => props.conflict
  const [showDetails, setShowDetails] = createSignal(false)

  return (
    <Dialog title="" class="w-full max-w-[320px] mx-auto">
      <div class="flex flex-col items-center gap-3 px-6 pb-2 pt-4 text-center">
        <span class="font-mono text-[24px] font-semibold text-text-strong tracking-tight">
          {conflict().port}
        </span>
        <span class="text-[13px] text-text-weak">Port is in use</span>

        <Show when={conflict().pid || conflict().command}>
          <button
            type="button"
            class="text-[11px] text-text-weakest hover:text-text-weak transition-colors"
            onClick={() => setShowDetails(!showDetails())}
          >
            {showDetails() ? "Hide details" : "Details"}
          </button>
          <Show when={showDetails()}>
            <div class="text-[11px] text-text-weak font-mono space-y-0.5 max-w-full">
              <Show when={conflict().pid}>
                <div class="truncate">PID {conflict().pid}</div>
              </Show>
              <Show when={conflict().command}>
                <div class="truncate">{conflict().command}</div>
              </Show>
            </div>
          </Show>
        </Show>
      </div>

      <div class="flex items-center justify-end gap-2 px-6 py-3">
        <Button type="button" variant="ghost" size="large" onClick={props.onCancel}>
          Cancel
        </Button>
        <div class="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="large"
          onClick={() => props.onResolve("kill-existing")}
        >
          Kill &amp; reclaim
        </Button>
        <Button
          type="button"
          variant="primary"
          size="large"
          onClick={() => props.onResolve("pick-new")}
        >
          Use another port
        </Button>
      </div>
    </Dialog>
  )
}
