import { For, Show, type JSX } from "solid-js"
import type { HarnessInfo } from "@/server"
import { Button, Icon, IconButton, Menu, ProviderIcon, isIconName } from "@/ui"
import { usePhone } from "@/lib/viewport"
import type { Selection } from "../model"
import { modelChoiceId } from "../selection"

export type PickerOption = { id: string; label: string; icon?: JSX.Element; disabled?: boolean; badge?: string }

export type Picker = {
  id: "agent" | "model" | "effort" | "permissionMode"
  title: string
  options: PickerOption[]
  current?: string
  fallback?: string
  locked?: boolean
  onSelect: (id: string) => void
}

function currentLabel(picker: Picker) {
  return picker.options.find((option) => option.id === picker.current)?.label ?? picker.current ?? picker.fallback ?? ""
}

function PickerItems(props: { picker: Picker }) {
  return (
    <Menu.RadioGroup value={props.picker.current} onChange={props.picker.onSelect}>
      <For each={props.picker.options}>
        {(option) => (
          <Menu.RadioItem value={option.id} disabled={option.disabled} closeOnSelect badge={option.badge}>
            {option.icon}
            {option.label}
          </Menu.RadioItem>
        )}
      </For>
    </Menu.RadioGroup>
  )
}

function PickerMenu(props: { picker: Picker }) {
  return (
    <Menu gutter={6} placement="top-start">
      <Menu.Trigger
        as={Button}
        variant="ghost-muted"
        size="small"
        data-slot="composer-picker"
        data-picker={props.picker.id}
        data-value={props.picker.current}
        disabled={props.picker.locked}
        aria-label={props.picker.title}
        title={props.picker.title}
      >
        <span data-slot="composer-picker-label">{currentLabel(props.picker)}</span>
        <Icon name="chevron-down" size="small" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content>
          <PickerItems picker={props.picker} />
        </Menu.Content>
      </Menu.Portal>
    </Menu>
  )
}

function PhonePickers(props: { pickers: Picker[]; title: string }) {
  return (
    <Menu gutter={6} placement="top-end">
      <Menu.Trigger as={IconButton} icon="sliders" size="large" variant="ghost-muted" data-slot="composer-picker" data-picker="all" aria-label={props.title} />
      <Menu.Portal>
        <Menu.Content>
          <For each={props.pickers}>
            {(picker) => (
              <Menu.Sub gutter={4}>
                <Menu.SubTrigger disabled={picker.locked}>
                  {picker.title}
                  <span data-slot="composer-picker-muted">{currentLabel(picker)}</span>
                </Menu.SubTrigger>
                <Menu.Portal>
                  <Menu.SubContent>
                    <PickerItems picker={picker} />
                  </Menu.SubContent>
                </Menu.Portal>
              </Menu.Sub>
            )}
          </For>
        </Menu.Content>
      </Menu.Portal>
    </Menu>
  )
}

export function harnessIcon(harness: HarnessInfo) {
  return isIconName(harness.id) ? <Icon name={harness.id} size="small" /> : undefined
}

type PickerText = (
  key: "composer.picker.agent" | "composer.picker.model" | "composer.picker.effort" | "composer.picker.permissionMode" | "composer.picker.unavailable" | "composer.picker.default",
) => string

type PickerInput = {
  harnesses: readonly HarnessInfo[]
  harness: HarnessInfo | undefined
  locked: boolean
  selection: Selection
  t: PickerText
  onSelect: (patch: Selection) => void
}

function agentPicker(input: PickerInput, harness: HarnessInfo): Picker {
  return {
    id: "agent",
    title: input.t("composer.picker.agent"),
    locked: input.locked,
    current: harness.id,
    options: input.harnesses.map((entry) => ({
      id: entry.id,
      label: entry.name,
      icon: harnessIcon(entry),
      disabled: !entry.available,
      badge: entry.available ? undefined : input.t("composer.picker.unavailable"),
    })),
    onSelect: (id) => input.onSelect({ harness: id, model: undefined, effort: undefined, permissionMode: undefined }),
  }
}

function modelPicker(input: PickerInput, harness: HarnessInfo): Picker {
  return {
    id: "model",
    title: input.t("composer.picker.model"),
    current: input.selection.model ? modelChoiceId(input.selection.model) : undefined,
    fallback: input.t("composer.picker.default"),
    options: harness.models.map((choice) => ({
      id: modelChoiceId(choice),
      label: choice.variant ? `${choice.modelId} (${choice.variant})` : choice.modelId,
      icon: <ProviderIcon id={choice.providerId} class="shrink-0" />,
    })),
    onSelect: (id) => input.onSelect({ model: harness.models.find((choice) => modelChoiceId(choice) === id) }),
  }
}

function listPicker(input: PickerInput, id: "effort" | "permissionMode", values: readonly string[]): Picker[] {
  if (values.length === 0) return []
  const title = input.t(id === "effort" ? "composer.picker.effort" : "composer.picker.permissionMode")
  const options = values.map((value) => ({ id: value, label: value }))
  const fallback = input.t("composer.picker.default")
  return [{ id, title, current: input.selection[id], fallback, options, onSelect: (value) => input.onSelect({ [id]: value }) }]
}

export function buildPickers(input: PickerInput): Picker[] {
  const harness = input.harness
  if (!harness) return []
  return [
    agentPicker(input, harness),
    ...(harness.models.length > 0 ? [modelPicker(input, harness)] : []),
    ...listPicker(input, "effort", harness.efforts),
    ...listPicker(input, "permissionMode", harness.permissionModes),
  ]
}

export function Pickers(props: { pickers: Picker[]; phoneTitle: string }) {
  const phone = usePhone()
  return (
    <div data-slot="composer-pickers">
      <Show when={!phone()} fallback={<PhonePickers pickers={props.pickers} title={props.phoneTitle} />}>
        <For each={props.pickers}>{(picker) => <PickerMenu picker={picker} />}</For>
      </Show>
    </div>
  )
}
