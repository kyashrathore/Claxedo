import { For, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { getTerminalCommands } from "../../components/settings-terminals"

export type WorkspaceBarItem = {
  id: string
  directory: string
  name: string
  notification?: boolean
  isMain?: boolean
  isCloud?: boolean
  canDelete?: boolean
  projectWorktree?: string
  available?: boolean
}

type WorkspaceScopeButtonsProps = {
  global?: boolean
  onNewSession?: () => void
  onNewTerminal?: (command?: string, title?: string) => void
  onNewPage?: () => void
  onSettings?: () => void
  class?: string
}

function commands() {
  const stored = getTerminalCommands()
  return {
    claude: stored.claude,
    codex: stored.codex,
    custom: stored.custom,
  }
}

export function WorkspaceScopeButtons(props: WorkspaceScopeButtonsProps) {
  return (
    <div class={`flex items-center gap-0 flex-shrink-0 ${props.class ?? ""}`}>
      <Tooltip value="New Session">
        <button
          type="button"
          class="flex items-center justify-center w-8 h-8 hover:bg-surface-base-hover text-text-weak hover:text-text-base transition-colors shrink-0 rounded"
          onClick={() => props.onNewSession?.()}
          aria-label="New Session"
        >
          <Icon name="plus-small" size="small" />
        </button>
      </Tooltip>

      <Tooltip value="New Claude Terminal">
        <Show when={!props.global}>
          <button
            type="button"
            class="flex items-center justify-center w-8 h-8 hover:bg-surface-base-hover text-text-weak hover:text-text-base transition-colors shrink-0 rounded"
            onClick={() => props.onNewTerminal?.(commands().claude, "Claude")}
            aria-label="New Claude Terminal"
          >
            <span class="text-xs font-bold">C</span>
          </button>
        </Show>
      </Tooltip>

      <Tooltip value="New Codex Terminal">
        <Show when={!props.global}>
          <button
            type="button"
            class="flex items-center justify-center w-8 h-8 hover:bg-surface-base-hover text-text-weak hover:text-text-base transition-colors shrink-0 rounded"
            onClick={() => props.onNewTerminal?.(commands().codex, "Codex")}
            aria-label="New Codex Terminal"
          >
            <span class="text-xs font-bold">X</span>
          </button>
        </Show>
      </Tooltip>

      <DropdownMenu>
        <DropdownMenu.Trigger data-component="workspace-more-menu" class="flex items-center justify-center w-8 h-8 hover:bg-surface-base-hover text-text-weak hover:text-text-base transition-colors cursor-pointer border-none bg-transparent shrink-0 rounded">
          <Icon name="chevron-down" size="small" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content class="z-[200]">
            <Show when={!props.global}>
              <DropdownMenu.Item onSelect={() => props.onNewTerminal?.()}>
                <Icon name="console" size="small" class="mr-2" />
                New Terminal
              </DropdownMenu.Item>
            </Show>
            <DropdownMenu.Item onSelect={() => props.onNewPage?.()}>
              <Icon name="page" size="small" class="mr-2" />
              New Page
            </DropdownMenu.Item>
            <Show when={!props.global && commands().custom.length > 0}>
              <DropdownMenu.Separator />
              <For each={commands().custom}>
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
