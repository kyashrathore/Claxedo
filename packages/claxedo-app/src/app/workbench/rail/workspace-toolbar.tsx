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
  canUseTerminal?: boolean
  onNewSession?: () => void
  onNewTerminal?: (command?: string, title?: string) => void
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
  const canUseTerminal = () => props.canUseTerminal !== false && !props.global
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

      <Tooltip value="New Claude Terminal">
        <Show when={canUseTerminal()}>
          <button
            type="button"
            class="flex size-6 shrink-0 items-center justify-center rounded-sm text-text-weak transition-colors hover:bg-surface-base-hover hover:text-text-base"
            onClick={() => props.onNewTerminal?.(workspaceScopeCommands().claude, "Claude")}
            aria-label="New Claude Terminal"
          >
            <Icon name="claude" size="small" />
          </button>
        </Show>
      </Tooltip>

      <Tooltip value="New Codex Terminal">
        <Show when={canUseTerminal()}>
          <button
            type="button"
            class="flex size-6 shrink-0 items-center justify-center rounded-sm text-text-weak transition-colors hover:bg-surface-base-hover hover:text-text-base"
            onClick={() => props.onNewTerminal?.(workspaceScopeCommands().codex, "Codex")}
            aria-label="New Codex Terminal"
          >
            <Icon name="openai" size="small" />
          </button>
        </Show>
      </Tooltip>

      <DropdownMenu>
        <DropdownMenu.Trigger data-component="workspace-more-menu" class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm border-none bg-transparent text-text-weak transition-colors hover:bg-surface-base-hover hover:text-text-base aria-expanded:bg-surface-base-active aria-expanded:text-text-base">
          <Icon name="chevron-down" size="small" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content class="z-[200]">
            <Show when={canUseTerminal()}>
              <DropdownMenu.Item onSelect={() => props.onNewTerminal?.()}>
                <Icon name="console" size="small" class="mr-2" />
                New Terminal
              </DropdownMenu.Item>
            </Show>
            <Show when={props.canUseDocuments === true}>
              <DropdownMenu.Item onSelect={() => props.onNewPage?.()}>
                <Icon name="page" size="small" class="mr-2" />
                New Document
              </DropdownMenu.Item>
            </Show>
            <Show when={canUseTerminal() && workspaceScopeCommands().custom.length > 0}>
              <DropdownMenu.Separator />
              <For each={workspaceScopeCommands().custom}>
                {(cmd) => (
                  <Show when={cmd.name && cmd.command}>
                    <DropdownMenu.Item onSelect={() => props.onNewTerminal?.(cmd.command, cmd.name)}>
                      <Icon name="console" size="small" class="mr-2" />
                      {cmd.name}
                    </DropdownMenu.Item>
                  </Show>
                )}
              </For>
            </Show>
            <DropdownMenu.Separator />
            <DropdownMenu.Item onSelect={() => props.onSettings?.()}>
              <Icon name="settings-gear" size="small" class="mr-2" />
              Configure...
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </div>
  )
}
