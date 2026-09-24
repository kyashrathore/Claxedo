import { Show } from "solid-js"
import { Icon, IconButton, Keybind, Menu, Tooltip } from "@/ui"
import type { ComposerSetup } from "../setup"
import { buildPickers, Pickers } from "./pickers"

function AddMenu(props: { composer: ComposerSetup }) {
  const t = () => props.composer.t
  const controller = () => props.composer.controller
  return (
    <Menu gutter={6} placement="top-start">
      <Menu.Trigger
        as={IconButton}
        icon="plus"
        size="large"
        variant="ghost-muted"
        data-action="composer-add"
        disabled={controller().state.mode === "shell" || props.composer.disabled()}
        aria-label={t()("composer.action.add")}
      />
      <Menu.Portal>
        <Menu.Content style={{ "min-width": "180px" }}>
          <Menu.Item onSelect={() => props.composer.refs.fileInput()?.click()} shortcut={<Keybind keys={["Mod", "U"]} variant="ghost" />}>
            {t()("composer.action.attach")}
          </Menu.Item>
          <Menu.Separator />
          <Menu.Item onSelect={() => controller().openCommands()} shortcut="/">
            {t()("composer.action.commands")}
          </Menu.Item>
          <Menu.Item onSelect={() => controller().openContext()} shortcut="@">
            {t()("composer.action.context")}
          </Menu.Item>
          <Menu.Item onSelect={() => controller().setMode("shell")} shortcut="!">
            {t()("composer.action.shell")}
          </Menu.Item>
          <Show when={props.composer.goalAvailable()}>
            <Menu.Separator />
            <Menu.Item onSelect={() => props.composer.send.armGoal()} data-action="composer-goal">
              {t()("composer.action.goal")}
            </Menu.Item>
          </Show>
        </Menu.Content>
      </Menu.Portal>
    </Menu>
  )
}

function GoalChip(props: { composer: ComposerSetup }) {
  const t = () => props.composer.t
  return (
    <Tooltip placement="top" value={t()("composer.action.clearGoal")}>
      <button
        type="button"
        data-slot="composer-goal-chip"
        data-action="composer-clear-goal"
        aria-pressed="true"
        aria-label={t()("composer.action.clearGoal")}
        onClick={() => props.composer.send.disarmGoal()}
      >
        <Icon name="circle-dashed" size="small" />
        <span>{t()("composer.action.goal")}</span>
      </button>
    </Tooltip>
  )
}

function SendButton(props: { composer: ComposerSetup }) {
  const t = () => props.composer.t
  const stopping = () => props.composer.working()
  const disabled = () => !stopping() && (props.composer.controller.blank() || props.composer.disabled() || props.composer.send.sending())
  return (
    <Tooltip placement="top" inactive={disabled()} value={t()(stopping() ? "composer.action.stop" : "composer.action.send")}>
      <IconButton
        type="button"
        icon={stopping() ? "stop" : "arrow-up"}
        size="normal"
        variant="contrast"
        data-action={stopping() ? "composer-stop" : "composer-send"}
        data-slot="composer-send"
        disabled={disabled()}
        aria-label={t()(stopping() ? "composer.action.stop" : "composer.action.send")}
        onClick={(event: MouseEvent) => {
          event.preventDefault()
          if (stopping()) void props.composer.send.stop()
          else void props.composer.send.send()
        }}
      />
    </Tooltip>
  )
}

export function ComposerToolbar(props: { composer: ComposerSetup; locked: boolean }) {
  const composer = () => props.composer
  const pickers = () =>
    buildPickers({
      harnesses: composer().harnesses(),
      harness: composer().harness(),
      locked: props.locked,
      selection: composer().selection(),
      t: composer().t,
      onSelect: (patch) => composer().store.setSelection(composer().key(), patch),
    })
  return (
    <div data-slot="composer-toolbar">
      <AddMenu composer={composer()} />
      <Show when={composer().draft().goalArmed}>
        <GoalChip composer={composer()} />
      </Show>
      <Pickers pickers={pickers()} phoneTitle={composer().t("composer.picker.agent")} />
      <SendButton composer={composer()} />
    </div>
  )
}
