import { createEffect, createSignal, For, Index, Show, type Component } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import { showToast } from "@opencode-ai/ui/toast"
import {
  defaultTerminalCommands,
  getTerminalCommands,
  saveTerminalCommands,
  terminalAgents,
  type TerminalAgentId,
  type TerminalCustomCommand,
} from "@/features/settings/app-ports"

function generateId() {
  return Math.random().toString(36).substring(2, 9)
}

export const SettingsTerminals: Component = () => {
  const initial = getTerminalCommands()
  const [agentCommands, setAgentCommands] = createStore<Record<TerminalAgentId, string>>(initial.agents)
  const [customCommands, setCustomCommands] = createStore<TerminalCustomCommand[]>(initial.custom)
  const [hasChanges, setHasChanges] = createSignal(false)

  createEffect(() => {
    const current = getTerminalCommands()
    const agentsChanged = terminalAgents().some((agent) => agentCommands[agent.id] !== current.agents[agent.id])
    const customChanged = JSON.stringify(customCommands) !== JSON.stringify(current.custom)
    setHasChanges(agentsChanged || customChanged)
  })

  const handleSave = () => {
    saveTerminalCommands({ agents: { ...agentCommands }, custom: [...customCommands] })
    setHasChanges(false)
    showToast({
      variant: "success",
      icon: "circle-check",
      title: "Terminal commands saved",
      description: "Your terminal command settings have been updated.",
    })
  }

  const handleReset = () => {
    setAgentCommands(defaultTerminalCommands().agents)
    setCustomCommands([])
  }

  let newCommandInputRef: HTMLInputElement | undefined

  const addCustomCommand = () => {
    const newId = generateId()
    setCustomCommands(customCommands.length, { id: newId, name: "", command: "" })
    requestAnimationFrame(() => {
      newCommandInputRef?.focus()
    })
  }

  const updateCustomCommand = (index: number, field: "name" | "command", value: string) => {
    setCustomCommands(index, field, value)
  }

  const removeCustomCommand = (index: number) => {
    setCustomCommands(produce((cmds) => cmds.splice(index, 1)))
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="flex flex-col gap-1 pt-6 pb-8">
        <h2 class="text-18-medium text-text-strong">Terminals</h2>
        <p class="text-12-regular text-text-weak">Configure the commands used when launching terminal sessions. The creator offers an agent once its CLI is installed on the machine the terminal runs on.</p>
      </div>

      <div class="flex flex-col gap-8 w-full">
        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong pb-2">Agent Commands</h3>
          <div class="bg-surface-raised-base px-4 rounded-lg">
            <For each={terminalAgents()}>
              {(agent) => (
                <div class="flex flex-col gap-2 py-3 border-b border-border-weak-base last:border-none">
                  <div class="flex flex-col gap-0.5">
                    <span class="text-14-medium text-text-strong">{agent.label}</span>
                    <span class="text-12-regular text-text-weak">{agent.hint}</span>
                  </div>
                  <input
                    id={`${agent.id}-command`}
                    type="text"
                    value={agentCommands[agent.id]}
                    onInput={(e) => setAgentCommands(agent.id, e.currentTarget.value)}
                    placeholder={agent.defaultCommand}
                    class="w-full px-3 py-2 bg-surface-base border border-border-base rounded-md text-text-base font-mono text-sm focus:outline-none focus:border-border-strong-base"
                  />
                </div>
              )}
            </For>
          </div>
        </div>

        <div class="flex flex-col gap-1">
          <div class="flex items-center justify-between pb-2">
            <div class="flex flex-col gap-0.5">
              <h3 class="text-14-medium text-text-strong">Custom Commands</h3>
              <p class="text-12-regular text-text-weak">Add custom commands that appear as tiles in the terminal creator.</p>
            </div>
            <Button size="small" variant="secondary" icon="plus-small" onClick={addCustomCommand}>
              Add
            </Button>
          </div>
          <div class="bg-surface-raised-base px-4 rounded-lg">
            <Show
              when={customCommands.length > 0}
              fallback={<div class="py-4 text-14-regular text-text-weak">No custom commands yet.</div>}
            >
              <Index each={customCommands}>
                {(cmd, index) => (
                  <div class="flex gap-3 items-start py-3 border-b border-border-weak-base last:border-none">
                    <div class="flex flex-col gap-2 flex-1 min-w-0">
                      <input
                        ref={(el) => {
                          if (index === customCommands.length - 1) {
                            newCommandInputRef = el
                          }
                        }}
                        type="text"
                        value={cmd().name}
                        onInput={(e) => updateCustomCommand(index, "name", e.currentTarget.value)}
                        placeholder="Command name (e.g., Aider)"
                        class="w-full px-3 py-2 bg-surface-base border border-border-base rounded-md text-text-base text-sm focus:outline-none focus:border-border-strong-base"
                      />
                      <input
                        type="text"
                        value={cmd().command}
                        onInput={(e) => updateCustomCommand(index, "command", e.currentTarget.value)}
                        placeholder="Command to run (e.g., aider --model gpt-4)"
                        class="w-full px-3 py-2 bg-surface-base border border-border-base rounded-md text-text-base font-mono text-sm focus:outline-none focus:border-border-strong-base"
                      />
                    </div>
                    <IconButton
                      icon="trash"
                      variant="ghost"
                      class="shrink-0 mt-1.5 text-text-weak hover:text-text-on-critical-base"
                      onClick={() => removeCustomCommand(index)}
                      aria-label="Remove command"
                    />
                  </div>
                )}
              </Index>
            </Show>
          </div>
        </div>

        <div class="flex items-center gap-2">
          <Button size="small" variant="primary" onClick={handleSave} disabled={!hasChanges()}>
            Save Changes
          </Button>
          <Button size="small" variant="ghost" onClick={handleReset}>
            Reset to Defaults
          </Button>
        </div>
      </div>
    </div>
  )
}
