import { For, Show, type Accessor, type JSX } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { COMPOSER_MENU_CLASS } from "@/features/session/composer/ui/menu-metrics"

/** The agent pair that the "Plan mode" toggle stands in for. When a workspace
 * exposes exactly these two, a single checkbox reads better than a two-option
 * radio group — which is why `planModeAgents` collapses them. Anything richer
 * (custom agents) falls through to the explicit Agent radio group. */
const BUILD_AGENT = "build"
const PLAN_AGENT = "plan"

export function planModeAgents(names: readonly string[]) {
  if (names.length !== 2) return undefined
  if (!names.includes(BUILD_AGENT) || !names.includes(PLAN_AGENT)) return undefined
  return { on: PLAN_AGENT, off: BUILD_AGENT }
}

/**
 * The composer's `+` control, matched to upstream's v2 prompt-input menu
 * (`session-ui/src/v2/components/prompt-input/index.tsx#PromptInputV2AddMenu`):
 * four actions under the compact "Add" group heading with right-aligned
 * keyboard hints and no inline descriptions.
 *
 *   Images and files   ⌘U    opens the native file chooser
 *   Commands           /     opens the `/` popover on an empty query
 *   Context            @     opens the `@` popover on an empty query
 *   Shell command      !     switches the composer into shell mode
 *
 * The hints are the *input triggers*, not command keybinds — `/`, `@` and `!`
 * are exactly what typing into the editor would do, which is what makes the
 * menu teach the keyboard path instead of duplicating it.
 *
 * Commands/Context deliberately do NOT insert a `/` or `@` character: both
 * lists populate on an empty query (`prompt-options.ts#promptAtOptions`),
 * so opening the surface is the whole action and the editor stays clean.
 * (On the flagged CONTROLLER engine — `composer/v2/engine-contract.ts` — the two
 * entries dispatch upstream's `commands.open`/`context.open` instead, which DO
 * seed the trigger character into the draft. Same surfaces, upstream's spelling.)
 *
 * The standalone "Documents" entry upstream has no equivalent of is gone: the
 * `documents.open` row is the first entry of the Commands popover
 * (`prompt-options.ts#promptSlashCommands`), so Commands -> Documents
 * reaches the same picker.
 *
 * `data-action="prompt-attach"` deliberately stays on the "Images and files"
 * item rather than moving to the trigger: that attribute means "the control that
 * opens the file chooser" to both the e2e suite and the `file.attach` keybind
 * docs, and the trigger no longer does that.
 *
 * Agent selection stays appended below a separator because this menu is the
 * only place it lives in our composer (upstream has a separate agent select in
 * the toolbar, we do not) — removing it would delete the control, not flatten it.
 */
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
      {/* fitViewport so a long menu is capped to the space above the composer
          rather than clipping its first entry off the top of the window. */}
      <MenuV2 placement="top-start" gutter={8} fitViewport>
        <MenuV2.Trigger
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
        </MenuV2.Trigger>
        <MenuV2.Portal>
          <MenuV2.Content
            class={`${COMPOSER_MENU_CLASS} overflow-y-auto`}
            style={{ "max-height": "min(420px, var(--kb-popper-content-available-height, 420px))" }}
          >
            <MenuV2.Group>
              <MenuV2.GroupLabel>Add</MenuV2.GroupLabel>
              <MenuV2.Item
                data-action="prompt-attach"
                shortcut={props.attachKeybind || undefined}
                onSelect={props.onAttach}
              >
                <span class="truncate">{props.attachLabel}</span>
              </MenuV2.Item>
              <MenuV2.Item data-action="prompt-commands" shortcut="/" onSelect={props.onCommands}>
                <span class="truncate">{props.commandsLabel}</span>
              </MenuV2.Item>
              <MenuV2.Item data-action="prompt-context" shortcut="@" onSelect={props.onContext}>
                <span class="truncate">{props.contextLabel}</span>
              </MenuV2.Item>
              <MenuV2.Item data-action="prompt-goal" disabled={props.goalDisabled()} onSelect={props.onGoal}>
                <span class="truncate">{props.goalLabel}</span>
              </MenuV2.Item>
              {/* An Item, not a CheckboxItem: entering shell mode fades the whole
                  toolbar to `pointer-events: none` (see createPromptToolbarMotion),
                  so this menu is unreachable once shell mode is on. A checkbox that
                  can be ticked but never unticked would be a lie — Escape and
                  backspace-on-empty are what exit. */}
              <MenuV2.Item data-action="prompt-shell-mode" shortcut="!" onSelect={props.onEnterShell}>
                <span class="truncate">{props.shellLabel}</span>
              </MenuV2.Item>
            </MenuV2.Group>
            <Show when={planAgents()}>
              {(agents) => (
                <>
                  <MenuV2.Separator />
                  <MenuV2.CheckboxItem
                    data-action="prompt-plan-mode"
                    checked={props.currentAgentName() === agents().on}
                    onChange={(checked) => props.onAgentSelect(checked ? agents().on : agents().off)}
                  >
                    <span class="truncate">{props.planModeLabel}</span>
                  </MenuV2.CheckboxItem>
                </>
              )}
            </Show>
            <Show when={showAgentRadioGroup()}>
              <MenuV2.Separator />
              <MenuV2.RadioGroup
                value={props.currentAgentName()}
                onChange={(value) => {
                  // Same no-op guard the inline agent `Select` carried: Kobalte
                  // re-fires onChange with the unchanged value when the options
                  // collection settles after load, and forwarding that would
                  // re-set the agent and yank focus back into the composer.
                  if (value && value !== props.currentAgentName()) props.onAgentSelect(value)
                }}
              >
                <MenuV2.GroupLabel>{props.agentGroupLabel}</MenuV2.GroupLabel>
                <For each={props.agentNames()}>
                  {(name) => (
                    <MenuV2.RadioItem data-action="prompt-agent" value={name} closeOnSelect>
                      <span class="truncate capitalize">{name}</span>
                    </MenuV2.RadioItem>
                  )}
                </For>
              </MenuV2.RadioGroup>
            </Show>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    </>
  )
}
