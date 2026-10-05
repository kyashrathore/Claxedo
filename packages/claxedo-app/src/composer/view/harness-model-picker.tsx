import { createMemo, createSignal } from "solid-js"
import { Popover as Kobalte } from "@kobalte/core/popover"
import { COMPOSER_MENU_CLASS } from "./menu-metrics"
import { type HarnessPickerSection } from "./harness-picker-section"
import { HarnessPickerHarnessSection, type HarnessSectionProps } from "./harness-picker-harness-section"
import { HarnessPickerModelSection, type ModelSectionProps } from "./harness-picker-model-section"
import { EffortRow, type EffortControlProps, type FastModeControl } from "./harness-picker-effort-row"
import { HarnessPickerTrigger, type TriggerProps } from "./harness-picker-trigger"

export type { FastModeControl }

export function HarnessModelPicker<H>(
  props: HarnessSectionProps<H> & ModelSectionProps & EffortControlProps & TriggerProps & { onOpen?: () => void },
) {
  const [open, setOpen] = createSignal(false)
  const [section, setSection] = createSignal<HarnessPickerSection | null>("model")

  const toggle = (next: HarnessPickerSection) =>
    setSection((current) => (current === next ? null : next))

  const groupedHarnesses = createMemo(() => {
    const groups = new Map<string, H[]>()
    for (const option of props.harnessOptions) {
      const group = props.harnessGroup(option)
      groups.set(group, [...(groups.get(group) ?? []), option])
    }
    return [...groups.entries()]
  })

  const currentVariant = createMemo(() => props.currentVariant() ?? "default")
  const effortLevels = createMemo(() => (props.showEffort() ? props.variants() : []))
  const effortInTrigger = createMemo(() => {
    const current = props.currentVariant()
    return current && current !== "default" ? props.variantLabel(current) : undefined
  })

  return (
    <Kobalte
      open={open()}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setSection(props.harness() === undefined ? "harness" : "model")
          props.onOpen?.()
        }
      }}
      modal={false}
      placement="top-end"
      gutter={4}
    >
      <HarnessPickerTrigger picker={props} effortInTrigger={effortInTrigger} />

      <Kobalte.Portal>
        <Kobalte.Content
          data-component="harness-model-picker"
          classList={{
            [`${COMPOSER_MENU_CLASS} claxedo-composer-menu-picker harness-picker-surface z-[260] flex flex-col gap-0.5 overflow-hidden outline-none`]: true,
            "h-[26rem]": section() === "model",
            "max-h-80": section() === "harness",
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
          }}
        >
          <Kobalte.Title class="sr-only">Select harness, model and effort</Kobalte.Title>

          <HarnessPickerHarnessSection
            picker={props}
            groups={groupedHarnesses}
            section={section}
            onToggle={() => toggle("harness")}
            onSelected={() => setSection("model")}
          />

          <HarnessPickerModelSection
            picker={props}
            section={section}
            onToggle={() => toggle("model")}
            onSelect={() => setOpen(false)}
          />

          <EffortRow
            levels={effortLevels()}
            current={currentVariant()}
            label={props.variantLabel}
            onSelect={props.onVariantSelect}
            fast={props.fast?.()}
            onFastToggle={(next) => props.onFastToggle?.(next)}
          />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}
