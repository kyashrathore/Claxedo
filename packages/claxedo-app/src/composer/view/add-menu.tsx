import { For, Show, type Accessor, type JSX } from "solid-js"
import { Icon, DropdownMenu } from "@/ui"
import { COMPOSER_MENU_CLASS } from "./menu-metrics"

const BUILD_AGENT = "build"
const PLAN_AGENT = "plan"

export function planModeAgents(names: readonly string[]) {
  if (names.length !== 2) return undefined
  if (!names.includes(BUILD_AGENT) || !names.includes(PLAN_AGENT)) return undefined
  return { on: PLAN_AGENT, off: BUILD_AGENT }
}

export function PromptAddMenu(props: {
  fileAttachmentInput: () => JSX.Element
  disabled: Accessor<boolean>
  triggerStyle: Accessor<JSX.CSSProperties>
  triggerLabel: string
  attachLabel: string
  attachKeybind: string
  onAttach: VoidFunction
  commandsLabel: string
  onCommands: VoidFunction
  contextLabel: string
  onContext: VoidFunction
  shellLabel: string
  onEnterShell: VoidFunction
  shellEnabled?: Accessor<boolean>
  goalLabel: string
  goalDisabled: Accessor<boolean>
  onGoal: VoidFunction
  agentNames: Accessor<string[]>
  currentAgentName: Accessor<string>
  onAgentSelect: (value: string) => void
  showAgentControls: Accessor<boolean>
  agentGroupLabel: string
  planModeLabel: string
}) {
  const planAgents = () => (props.showAgentControls() ? planModeAgents(props.agentNames()) : undefined)
  const showAgentRadioGroup = () => props.showAgentControls() && !planAgents()

  return (
    <>
      {props.fileAttachmentInput()}
      <DropdownMenu placement="top-start" gutter={8} fitViewport>
        <DropdownMenu.Trigger
          data-action="prompt-add"
          type="button"
          aria-label={props.triggerLabel}
          title={props.triggerLabel}
          disabled={props.disabled()}
          tabIndex={props.disabled() ? -1 : undefined}
          style={props.triggerStyle()}
          class="flex size-7 shrink-0 items-center justify-center rounded-md p-[6px] text-v2-icon-icon-muted transition-colors duration-150 hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-icon-icon-base disabled:pointer-events-none disabled:opacity-50 data-[expanded]:bg-v2-overlay-simple-overlay-hover data-[expanded]:text-v2-icon-icon-base"
        >
          <Icon name="plus" size="small" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            class={`${COMPOSER_MENU_CLASS} overflow-y-auto`}
            style={{ "max-height": "min(420px, var(--kb-popper-content-available-height, 420px))" }}
          >
            <DropdownMenu.Group>
              <DropdownMenu.GroupLabel>Add</DropdownMenu.GroupLabel>
              <DropdownMenu.Item
                data-action="prompt-attach"
                shortcut={props.attachKeybind || undefined}
                onSelect={props.onAttach}
              >
                <span class="truncate">{props.attachLabel}</span>
              </DropdownMenu.Item>
              <DropdownMenu.Item data-action="prompt-commands" shortcut="/" onSelect={props.onCommands}>
                <span class="truncate">{props.commandsLabel}</span>
              </DropdownMenu.Item>
              <DropdownMenu.Item data-action="prompt-context" shortcut="@" onSelect={props.onContext}>
                <span class="truncate">{props.contextLabel}</span>
              </DropdownMenu.Item>
              <DropdownMenu.Item data-action="prompt-goal" disabled={props.goalDisabled()} onSelect={props.onGoal}>
                <span class="truncate">{props.goalLabel}</span>
              </DropdownMenu.Item>
              <Show when={props.shellEnabled?.() !== false}><DropdownMenu.Item data-action="prompt-shell-mode" shortcut="!" onSelect={props.onEnterShell}>
                <span class="truncate">{props.shellLabel}</span>
              </DropdownMenu.Item></Show>
            </DropdownMenu.Group>
            <Show when={planAgents()}>
              {(agents) => (
                <>
                  <DropdownMenu.Separator />
                  <DropdownMenu.CheckboxItem
                    data-action="prompt-plan-mode"
                    checked={props.currentAgentName() === agents().on}
                    onChange={(checked) => props.onAgentSelect(checked ? agents().on : agents().off)}
                  >
                    <span class="truncate">{props.planModeLabel}</span>
                  </DropdownMenu.CheckboxItem>
                </>
              )}
            </Show>
            <Show when={showAgentRadioGroup()}>
              <DropdownMenu.Separator />
              <DropdownMenu.RadioGroup
                value={props.currentAgentName()}
                onChange={(value) => {
                  if (value && value !== props.currentAgentName()) props.onAgentSelect(value)
                }}
              >
                <DropdownMenu.GroupLabel>{props.agentGroupLabel}</DropdownMenu.GroupLabel>
                <For each={props.agentNames()}>
                  {(name) => (
                    <DropdownMenu.RadioItem data-action="prompt-agent" value={name} closeOnSelect>
                      <span class="truncate capitalize">{name}</span>
                    </DropdownMenu.RadioItem>
                  )}
                </For>
              </DropdownMenu.RadioGroup>
            </Show>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </>
  )
}
