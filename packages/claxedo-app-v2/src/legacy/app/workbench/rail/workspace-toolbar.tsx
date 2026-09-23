import { Show } from "solid-js"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"

export type WorkspaceBarItem = {
  id: string
  directory: string
  workspaceId?: string
  workspaceName?: string
  name: string
  notification?: boolean
  isMain?: boolean
  isCloud?: boolean
  canDelete?: boolean
  projectWorktree?: string
  available?: boolean
}

export type WorkspaceBarProject = {
  id: string
  name: string
  workspaces: WorkspaceBarItem[]
}

type WorkspaceScopeButtonsProps = {
  global?: boolean
  /** Role permits starting terminals. NOT a surface check — see the creator. */
  canCreateTerminal?: boolean
  onNewSession?: () => void
  /** Opens the terminal creator; the header has no directory worth guessing. */
  onNewTerminalDraft?: () => void
  onNewPage?: () => void
  canUseDocuments?: boolean
  class?: string
}

export function WorkspaceScopeButtons(props: WorkspaceScopeButtonsProps) {
  // Shown on global surfaces (Marketplace, Global chat) too: there
  // is no workspace there, and asking for one is exactly what the creator does.
  const canCreateTerminal = () => props.canCreateTerminal !== false
  return (
    <div class={`flex shrink-0 items-center gap-0.5 ${props.class ?? ""}`}>
      <Tooltip value="New Session">
        <button
          type="button"
          class="flex size-6 shrink-0 items-center justify-center rounded-sm text-text-weak transition-colors hover:bg-surface-base-hover hover:text-text-base"
          onClick={() => props.onNewSession?.()}
          aria-label="New Session"
        >
          <Icon name="plus-small" size="small" />
        </button>
      </Tooltip>

      {/* One terminal button, and it asks before it starts anything. The
          header's directory is a fallback chain (`sidebarDir() ??
          focusedPaneWorkspaceDir()`), so the per-agent shortcuts that used to
          sit here were starting an agent somewhere the user never picked. The
          creator lists those same agents once a workspace is chosen. */}
      <Tooltip value="New Terminal">
        <Show when={canCreateTerminal()}>
          <button
            type="button"
            class="flex size-6 shrink-0 items-center justify-center rounded-sm text-text-weak transition-colors hover:bg-surface-base-hover hover:text-text-base"
            onClick={() => props.onNewTerminalDraft?.()}
            aria-label="New Terminal"
            data-testid="workspace-scope-new-terminal"
          >
            <Icon name="terminal" size="small" />
          </button>
        </Show>
      </Tooltip>

      {/* New Document is the only entry, so the trigger goes with it. Terminal
          entries live in the creator (which asks for a workspace first) and
          Settings in the account menu; a chevron that opened a one-item menu
          was a second route to both. */}
      <Show when={props.canUseDocuments === true && props.onNewPage}>
        <DropdownMenu>
          <DropdownMenu.Trigger aria-label="More actions" data-component="workspace-more-menu" class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm border-none bg-transparent text-text-weak transition-colors hover:bg-surface-base-hover hover:text-text-base aria-expanded:bg-surface-base-active aria-expanded:text-text-base">
            <Icon name="chevron-down" size="small" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content class="z-[200]">
              <DropdownMenu.Item onSelect={() => props.onNewPage?.()}>
                <Icon name="page" size="small" style={{ width: "14px", height: "14px", margin: "1px" }} />
                New Document
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu>
      </Show>
    </div>
  )
}
