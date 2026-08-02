import { For, Show, createMemo, createSignal } from "solid-js"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { useTheme } from "@opencode-ai/ui/theme"
import { getTerminalCommands } from "../../../features/settings/ui/terminals"

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

type WorkspaceBarProps = {
  projects: WorkspaceBarProject[]
}



type WorkspaceScopeButtonsProps = {
  global?: boolean
  /** Role permits starting terminals. NOT a surface check — see the creator. */
  canCreateTerminal?: boolean
  onNewSession?: () => void
  /** Opens the terminal creator; the header has no directory worth guessing. */
  onNewTerminalDraft?: () => void
  onNewTask?: () => void
  onNewPage?: () => void
  canUseDocuments?: boolean
  onSettings?: () => void
  class?: string
}

function workspaceScopeCommands() {
  const stored = getTerminalCommands()
  return {
    claude: stored.claude,
    codex: stored.codex,
    custom: stored.custom,
  }
}

export function WorkspaceScopeButtons(props: WorkspaceScopeButtonsProps) {
  // Shown on global surfaces (WorkGraph, Marketplace, Global chat) too: there
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

      <Tooltip value="New task">
        <button
          type="button"
          class="flex size-6 shrink-0 items-center justify-center rounded-sm text-text-weak transition-colors hover:bg-surface-base-hover hover:text-text-base"
          onClick={() => props.onNewTask?.()}
          aria-label="New task"
          data-testid="workspace-scope-new-task"
        >
          <Icon name="checklist" size="small" />
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

      <DropdownMenu>
        <DropdownMenu.Trigger data-component="workspace-more-menu" class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm border-none bg-transparent text-text-weak transition-colors hover:bg-surface-base-hover hover:text-text-base aria-expanded:bg-surface-base-active aria-expanded:text-text-base">
          <Icon name="chevron-down" size="small" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content class="z-[200]">
            {/* No terminal entries here any more. "New Terminal" is the button
                beside this trigger, and the custom commands it used to list are
                tiles in the creator — where they run somewhere the user picked
                rather than somewhere the header inferred. */}
            <Show when={props.canUseDocuments === true}>
              <DropdownMenu.Item onSelect={() => props.onNewPage?.()}>
                <Icon name="page" size="small" style={{ width: "14px", height: "14px" }} />
                New Document
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
            </Show>
            <DropdownMenu.Item onSelect={() => props.onSettings?.()}>
              <Icon name="settings-gear" size="small" style={{ width: "14px", height: "14px" }} />
              Configure...
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </div>
  )
}
