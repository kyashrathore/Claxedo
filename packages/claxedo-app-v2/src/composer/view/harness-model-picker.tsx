import { For, Show, createMemo, createSignal, type Accessor, type JSX } from "solid-js"
import { Popover as Kobalte } from "@kobalte/core/popover"
import { ClaxedoIcon as Icon, Button } from "@/ui"
import { ModelList, type PickerState } from "./model-list"
import { COMPOSER_MENU_CLASS } from "./menu-metrics"

type HarnessModelPickerSection = "harness" | "model"

const ROW_CLASS =
  "flex min-h-7 w-full items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-1 text-left outline-none transition-colors duration-150 hover:bg-surface-base-hover focus-visible:bg-surface-base-hover"

function SectionHeader(props: {
  label: string
  value: string
  expanded: boolean
  loading?: boolean
  disabled?: boolean
  hint?: string
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      data-expanded={props.expanded ? "true" : undefined}
      disabled={props.disabled || props.loading}
      aria-busy={props.loading}
      aria-expanded={props.expanded}
      title={props.hint}
      class={`group/section shrink-0 disabled:pointer-events-none disabled:opacity-45 ${ROW_CLASS}`}
      onClick={props.onToggle}
    >
      <Icon
        name="chevron-right"
        size="small"
        class="shrink-0 text-icon-base transition-transform duration-200 ease-out group-data-[expanded=true]/section:rotate-90"
      />
      <span class="shrink-0 text-compact font-medium text-text-base">{props.label}</span>
      <span class="flex min-w-0 flex-1 items-center justify-end gap-1.5">
        <Show when={props.loading}>
          <span
            aria-hidden="true"
            class="size-3 shrink-0 animate-spin rounded-full border border-border-base border-t-transparent"
          />
        </Show>
        <span
          class="min-w-0 truncate text-right text-compact transition-colors duration-150"
          classList={{
            "text-text-weak": !props.expanded && !props.loading,
            "text-text-weaker": props.expanded || props.loading,
          }}
        >
          {props.loading ? "Loading…" : props.value}
        </span>
      </span>
    </button>
  )
}

function SectionPanel(props: { class?: string; children: JSX.Element }) {
  return (
    <div class={`harness-picker-panel ${props.class ?? ""}`}>
      {props.children}
    </div>
  )
}

function OptionRow(props: { selected: boolean; icon?: JSX.Element; label: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      aria-current={props.selected ? "true" : undefined}
      class={`text-compact ${ROW_CLASS}`}
      onClick={props.onSelect}
    >
      <Show when={props.icon}>
        <span class="flex shrink-0 items-center">{props.icon}</span>
      </Show>
      <span
        class="min-w-0 flex-1 truncate"
        classList={{ "text-text-base": props.selected, "text-text-weak": !props.selected }}
      >
        {props.label}
      </span>
      <Icon
        name="check"
        size="small"
        class="shrink-0 text-icon-base"
        classList={{ invisible: !props.selected }}
      />
    </button>
  )
}

export type FastModeControl = {
  on: boolean
  label: string
  description?: string
}

function EffortRow(props: {
  levels: string[]
  current: string
  label: (value: string) => string
  onSelect: (value: string) => void
  fast?: FastModeControl
  onFastToggle: (next: boolean) => void
}) {
  return (
    <div class="harness-picker-effort-row" data-fast={props.fast ? "true" : undefined}>
      <Show
        when={props.levels.length > 1}
        fallback={<div data-supported="false" class="harness-picker-effort" title="No effort control" />}
      >
        <EffortSlider levels={props.levels} current={props.current} label={props.label} onSelect={props.onSelect} />
      </Show>
      <Show when={props.fast}>
        {(fast) => (
          <button
            type="button"
            aria-pressed={fast().on}
            aria-label={fast().label}
            title={fast().description ? `${fast().label} · ${fast().description}` : fast().label}
            class="harness-picker-fast"
            onClick={() => props.onFastToggle(!fast().on)}
          >
            <Icon name="bolt" size="small" />
          </button>
        )}
      </Show>
    </div>
  )
}

function EffortSlider(props: {
  levels: string[]
  current: string
  label: (value: string) => string
  onSelect: (value: string) => void
}) {
  const [dragging, setDragging] = createSignal(false)
  const index = createMemo(() => Math.max(0, props.levels.indexOf(props.current)))
  const last = createMemo(() => props.levels.length - 1)
  const ratio = createMemo(() => index() / last())

  const select = (next: number) => {
    const value = props.levels[Math.max(0, Math.min(last(), next))]
    if (value !== undefined && value !== props.current) props.onSelect(value)
  }
  const indexAt = (element: HTMLElement, clientX: number) => {
    const box = element.getBoundingClientRect()
    const inset = Number.parseFloat(getComputedStyle(element).getPropertyValue("--effort-stop-inset")) || 0
    const travel = box.width - inset * 2
    if (travel <= 0) return index()
    return Math.round(((clientX - box.left - inset) / travel) * last())
  }

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="Effort"
      aria-valuemin={0}
      aria-valuemax={last()}
      aria-valuenow={index()}
      aria-valuetext={props.label(props.current)}
      title={`Effort · ${props.label(props.current)}`}
      data-supported="true"
      data-dragging={dragging() ? "true" : undefined}
      class="harness-picker-effort"
      style={{ "--effort-ratio": ratio() }}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.currentTarget.setPointerCapture(event.pointerId)
        setDragging(true)
        select(indexAt(event.currentTarget, event.clientX))
      }}
      onPointerMove={(event) => {
        if (!dragging()) return
        select(indexAt(event.currentTarget, event.clientX))
      }}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onKeyDown={(event) => {
        const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[event.key]
        if (step !== undefined) select(index() + step)
        else if (event.key === "Home") select(0)
        else if (event.key === "End") select(last())
        else return
        event.preventDefault()
      }}
    >
      <span aria-hidden="true" class="harness-picker-effort-fill" />
      <For each={props.levels}>
        {(_, stop) => (
          <span
            aria-hidden="true"
            class="harness-picker-effort-stop"
            data-filled={stop() <= index() ? "true" : undefined}
            style={{ "--effort-stop": stop() / last() }}
          />
        )}
      </For>
      <span aria-hidden="true" class="harness-picker-effort-thumb" />
    </div>
  )
}


export function HarnessModelPicker<H>(props: {
  harness: Accessor<H | undefined>
  harnessOptions: readonly H[]
  harnessLabel: (harness: H) => string
  harnessSelected?: (option: H, current: H | undefined) => boolean
  harnessGroup: (harness: H) => string
  harnessDisabled: Accessor<boolean>
  harnessHint?: Accessor<string | undefined>
  onHarnessSelect: (harness: H) => void

  harnessIcon: (harness: H | undefined) => JSX.Element

  model: Accessor<PickerState>
  modelLabel: Accessor<string>
  modelLoading: Accessor<boolean>
  modelDisabled: Accessor<boolean>
  modelError?: Accessor<{ message: string; detail?: string; action?: { label: string; run: () => void } } | undefined>

  onOpen?: () => void
  showEffort: Accessor<boolean>
  variants: Accessor<string[]>
  currentVariant: Accessor<string | undefined>
  variantLabel: (value: string) => string
  onVariantSelect: (value: string) => void
  fast?: Accessor<FastModeControl | undefined>
  onFastToggle?: (next: boolean) => void

  triggerStyle?: Accessor<JSX.CSSProperties>
  triggerLabel?: string
  triggerHint?: Accessor<string | undefined>
  triggerState?: Accessor<{
    harness: string
    model?: string
    provider?: string
    readiness: string
    readyForSubmit: boolean
  }>
}) {
  const [open, setOpen] = createSignal(false)
  const [section, setSection] = createSignal<HarnessModelPickerSection | null>("model")

  const toggle = (next: HarnessModelPickerSection) =>
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
        if (next) props.onOpen?.()
        if (!next) setSection("model")
      }}
      modal={false}
      placement="top-end"
      gutter={4}
    >
      <Kobalte.Trigger
        as={Button}
        variant="ghost"
        size="normal"
        style={props.triggerStyle?.()}
        disabled={props.modelDisabled() && props.harnessDisabled()}
        aria-label={props.triggerLabel ?? "Select harness, model and effort"}
        title={props.triggerHint?.()}
        data-action="prompt-harness-model"
        data-harness={props.triggerState?.().harness}
        data-model={props.triggerState?.().model}
        data-provider={props.triggerState?.().provider}
        data-readiness={props.triggerState?.().readiness}
        data-ready-for-submit={props.triggerState?.().readyForSubmit ? "true" : "false"}
        class="composer-harness-model group min-w-0 max-w-[260px] max-md:max-w-[132px] text-13-regular"
      >
        <span class="flex shrink-0 items-center">{props.harnessIcon(props.harness())}</span>
        <span data-slot="composer-control-label" class="truncate">{props.modelLabel()}</span>
        <Show when={props.showEffort() && effortInTrigger()}>
          <span class="shrink-0 text-v2-text-text-faint">{effortInTrigger()}</span>
        </Show>
        <Show when={props.fast?.()?.on}>
          <Icon name="bolt" size="small" aria-label={props.fast?.()?.label} class="shrink-0 text-v2-text-text-faint" />
        </Show>
        <Icon name="chevron-down" size="small" class="shrink-0 text-v2-icon-icon-muted" />
      </Kobalte.Trigger>

      <Kobalte.Portal>
        <Kobalte.Content
          data-component="harness-model-picker"
          classList={{
            [`${COMPOSER_MENU_CLASS} claxedo-composer-menu-picker harness-picker-surface z-[260] flex flex-col gap-0.5 overflow-hidden outline-none`]: true,
            "h-[26rem]": section() === "model",
            "h-80": section() === "harness",
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
          }}
        >
          <Kobalte.Title class="sr-only">Select harness, model and effort</Kobalte.Title>

          <SectionHeader
            label="Harness"
            value={props.harness() ? props.harnessLabel(props.harness()!) : "Select agent"}
            expanded={section() === "harness"}
            disabled={props.harnessDisabled()}
            hint={props.harnessHint?.()}
            onToggle={() => toggle("harness")}
          />
          <Show when={section() === "harness"}>
            <SectionPanel class="min-h-0 flex-1 overflow-y-auto">
              <For each={groupedHarnesses()}>
                {([group, options]) => (
                  <>
                    <div class="px-2 pb-0.5 pt-2 text-xs font-medium uppercase tracking-[var(--letter-spacing-label)] text-text-weaker first:pt-0.5">
                      {group}
                    </div>
                    <For each={options}>
                      {(option) => (
                        <OptionRow
                          selected={props.harnessSelected?.(option, props.harness()) ?? option === props.harness()}
                          icon={props.harnessIcon(option)}
                          label={props.harnessLabel(option)}
                          onSelect={() => {
                            if (!(props.harnessSelected?.(option, props.harness()) ?? option === props.harness())) props.onHarnessSelect(option)
                            setSection("model")
                          }}
                        />
                      )}
                    </For>
                  </>
                )}
              </For>
            </SectionPanel>
          </Show>

          <SectionHeader
            label="Model"
            value={props.modelLabel()}
            loading={props.modelLoading()}
            expanded={section() === "model" && !props.modelLoading()}
            onToggle={() => toggle("model")}
          />
          <Show when={section() === "model" && !props.modelLoading()}>
            <SectionPanel class="flex min-h-0 flex-1 flex-col">
              <Show
                when={props.modelError?.()}
                fallback={<ModelList model={props.model()} tooltips={false} onSelect={() => setOpen(false)} />}
              >
                {(failure) => (
                  <div class="flex min-h-0 flex-1 flex-col items-start gap-2 px-3 py-4">
                    <div class="flex items-center gap-2">
                      <span aria-hidden="true" class="size-1.5 shrink-0 rounded-full bg-icon-critical-base" />
                      <span class="text-compact font-medium text-text-base">{failure().message}</span>
                    </div>
                    <Show when={failure().detail}>
                      <p class="line-clamp-3 text-sm leading-snug text-text-weak" title={failure().detail}>
                        {failure().detail}
                      </p>
                    </Show>
                    <Show when={failure().action}>
                      {(action) => (
                        <button
                          type="button"
                          class="mt-0.5 rounded-md px-2 py-1 text-compact text-text-base outline-none transition-colors duration-100 hover:bg-surface-base-hover focus-visible:bg-surface-base-hover"
                          onClick={() => action().run()}
                        >
                          {action().label}
                        </button>
                      )}
                    </Show>
                  </div>
                )}
              </Show>
            </SectionPanel>
          </Show>

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
