import { For, Show, type Accessor, type JSX } from "solid-js"
import { OptionRow } from "./harness-picker-option-row"
import { SectionHeader, SectionPanel, type HarnessPickerSection } from "./harness-picker-section"

export type HarnessSectionProps<H> = {
  harness: Accessor<H | undefined>
  harnessOptions: readonly H[]
  harnessLabel: (harness: H) => string
  harnessSelected?: (option: H, current: H | undefined) => boolean
  harnessGroup: (harness: H) => string
  harnessDisabled: Accessor<boolean>
  harnessHint?: Accessor<string | undefined>
  onHarnessSelect: (harness: H) => void
  harnessIcon: (harness: H | undefined) => JSX.Element
}

export function HarnessPickerHarnessSection<H>(props: {
  picker: HarnessSectionProps<H>
  groups: Accessor<[string, H[]][]>
  section: Accessor<HarnessPickerSection | null>
  onToggle: () => void
  onSelected: () => void
}) {
  const selected = (option: H) =>
    props.picker.harnessSelected?.(option, props.picker.harness()) ?? option === props.picker.harness()

  return (
    <>
      <SectionHeader
        label="Harness"
        value={props.picker.harness() ? props.picker.harnessLabel(props.picker.harness()!) : "Select a harness"}
        expanded={props.section() === "harness"}
        disabled={props.picker.harnessDisabled()}
        hint={props.picker.harnessHint?.()}
        onToggle={props.onToggle}
      />
      <Show when={props.section() === "harness"}>
        <SectionPanel class="min-h-0 flex-1 overflow-y-auto">
          <For each={props.groups()}>
            {([group, options]) => (
              <>
                <Show when={props.groups().length > 1}>
                  <div class="px-2 pb-0.5 pt-2 text-xs font-medium text-text-weak first:pt-0.5">{group}</div>
                </Show>
                <For each={options}>
                  {(option) => (
                    <OptionRow
                      selected={selected(option)}
                      icon={props.picker.harnessIcon(option)}
                      label={props.picker.harnessLabel(option)}
                      onSelect={() => {
                        if (!selected(option)) props.picker.onHarnessSelect(option)
                        props.onSelected()
                      }}
                    />
                  )}
                </For>
              </>
            )}
          </For>
        </SectionPanel>
      </Show>
    </>
  )
}
