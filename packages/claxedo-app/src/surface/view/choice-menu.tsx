import { For, Show } from "solid-js"
import { DropdownMenu } from "@/ui"
import type { SurfaceIconName } from "../icon-names"
import { SurfaceIcon } from "./surface-icon"

export type MenuChoice = { readonly value: string; readonly label: string; readonly icon: SurfaceIconName | undefined }

export type ChoiceMenuProps = {
  readonly label: string | undefined
  readonly choices: readonly MenuChoice[]
  readonly current: string | undefined
  readonly iconOnly: boolean
  readonly onPick: (value: string) => void
}

export function ChoiceMenu(props: ChoiceMenuProps) {
  const chosen = () => props.choices.find((choice) => choice.value === props.current)
  const name = () => [props.label, chosen()?.label].filter((part) => part !== undefined && part !== "").join(": ")
  return (
    <DropdownMenu placement="bottom-start" gutter={4}>
      <DropdownMenu.Trigger data-slot="surface-menu-chip" data-icon-only={props.iconOnly ? "true" : "false"} aria-label={name()} title={props.iconOnly ? name() : undefined}>
        <Show when={chosen()?.icon}>{(icon) => <SurfaceIcon name={icon()} size="small" />}</Show>
        <Show when={!props.iconOnly}>
          <span data-slot="surface-menu-chip-label">{chosen()?.label ?? props.label}</span>
        </Show>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content aria-label={props.label}>
          <DropdownMenu.RadioGroup value={props.current ?? ""} onChange={(value: string) => props.onPick(value)}>
            <For each={props.choices}>
              {(choice) => (
                <DropdownMenu.RadioItem value={choice.value} closeOnSelect>
                  <span data-slot="surface-menu-option">
                    <Show when={choice.icon}>{(icon) => <SurfaceIcon name={icon()} size="small" />}</Show>
                    {choice.label}
                  </span>
                </DropdownMenu.RadioItem>
              )}
            </For>
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}
