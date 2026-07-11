/**
 * Dialog for choosing between Local and Cloud workspace types.
 *
 * Shown when sandboxEnabled is true, allowing users to choose
 * between creating a local git worktree or a cloud sandbox.
 */

import { Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { useConfigOptional } from "../context/config"

export interface DialogNewProjectProps {
  onLocal: () => void
  onCloud: () => void
  onClose?: () => void
  /** Override dialog title (default: "New Workspace") */
  title?: string
  /** Override description text */
  description?: string
}

/**
 * Local vs Cloud workspace type selection dialog.
 */
export function DialogNewProject(props: DialogNewProjectProps) {
  const config = useConfigOptional()

  const isCloudAvailable = () => {
    return !!config?.sandboxEnabled
  }

  return (
    <Dialog title={props.title ?? "New Workspace"} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3 min-w-[380px]">
        <p class="text-13-regular text-text-weak">
          {props.description ?? "Choose an environment for this workspace"}
        </p>

        <div class="flex flex-col gap-2">
          {/* Local worktree */}
          <button
            type="button"
            class="group relative flex items-center gap-3.5 px-3.5 py-3 rounded-md border border-border-weak-base text-left transition-all duration-150 hover:bg-surface-raised-base hover:border-border-base focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-interactive-focus"
            onClick={props.onLocal}
          >
            <div class="shrink-0 flex items-center justify-center size-8 rounded-md bg-surface-inset-base border border-border-weak-base transition-colors group-hover:border-border-base">
              <Icon name="folder" size="small" class="text-icon-base" />
            </div>
            <div class="flex flex-col gap-0.5 min-w-0">
              <span class="text-13-medium text-text-strong">Local Worktree</span>
              <span class="text-12-regular text-text-weak">Git worktree on this machine</span>
            </div>
            <div class="ml-auto shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
              <Icon name="chevron-right" size="small" class="text-icon-weak-base" />
            </div>
          </button>

          {/* Cloud sandbox */}
          <button
            type="button"
            class="group relative flex items-center gap-3.5 px-3.5 py-3 rounded-md border border-border-weak-base text-left transition-all duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-interactive-focus"
            classList={{
              "hover:bg-surface-raised-base hover:border-border-base": isCloudAvailable(),
              "opacity-40 cursor-not-allowed": !isCloudAvailable(),
            }}
            onClick={() => isCloudAvailable() && props.onCloud()}
            disabled={!isCloudAvailable()}
          >
            <div
              class="shrink-0 flex items-center justify-center size-8 rounded-md border transition-colors"
              classList={{
                "bg-surface-interactive-base/8 border-border-interactive-base/20 group-hover:border-border-interactive-base/40": isCloudAvailable(),
                "bg-surface-inset-base border-border-weak-base": !isCloudAvailable(),
              }}
            >
              <Icon
                name="cloud-upload"
                size="small"
                class={isCloudAvailable() ? "text-text-interactive-base" : "text-icon-weak-base"}
              />
            </div>
            <div class="flex flex-col gap-0.5 min-w-0">
              <span class="text-13-medium text-text-strong">Cloud Sandbox</span>
              <Show
                when={isCloudAvailable()}
                fallback={
                  <span class="text-12-regular text-icon-warning-base">
                    Enable in Settings to use cloud sandboxes
                  </span>
                }
              >
                <span class="text-12-regular text-text-weak">Isolated VM via Daytona or Modal</span>
              </Show>
            </div>
            <Show when={isCloudAvailable()}>
              <div class="ml-auto shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                <Icon name="chevron-right" size="small" class="text-icon-weak-base" />
              </div>
            </Show>
          </button>
        </div>

        <div class="flex justify-end">
          <Button variant="ghost" size="large" onClick={props.onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
