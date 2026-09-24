import { For, Show, createMemo, createSignal, type Accessor, type JSX } from "solid-js"
import { Popover as Kobalte } from "@kobalte/core/popover"
import { Button } from "@opencode-ai/ui/button"
import { ClaxedoIcon as Icon } from "@/ui"
import { ModelList, type PickerState } from "./model-list"
import { COMPOSER_MENU_CLASS } from "./menu-metrics"

/**
 * One chip, one popover, three questions — harness, model, effort.
 *
 * Three separate chips would read as unrelated settings when they are in fact
 * one decision made in order: the harness decides which models exist, and the
 * model decides whether effort (and a fast tier) is offered at all. The two
 * list questions are an accordion — pick a harness and it folds shut, handing
 * you the model list it just produced. Effort is an ordered scale, not a list,
 * so it is a slider pinned under both sections and stays visible while the
 * model list is open (see `EffortRow`).
 *
 * At most one section is open. That is what keeps the popover a FIXED height
 * (`h-80`, the same as the model picker it replaces) instead of a stack that
 * runs off-screen once a harness has thirty models.
 *
 * Three things carry the hierarchy, because "is this panel a child of that
 * header?" is the only question this layout can get wrong:
 *   1. the open header keeps a held background, so it reads as the thing the
 *      panel belongs to rather than a divider above it;
 *   2. the panel is inset to the header's LABEL, not its edge, so the chevron
 *      column becomes a visible spine down the open section;
 *   3. the panel fades and slides in from the header it hangs off.
 *
 * The model section hosts the REAL `ModelList` — its search, provider
 * grouping and tags, and its Settings → Providers redirect for a model that
 * is not connected.
 */

type HarnessModelPickerSection = "harness" | "model"

/**
 * Every list row in this popover — the section headers, the harness options
 * and the model list's own rows — is this one box. Same
 * width, same 10px gutter, same radius, same hover.
 *
 * A row narrower than the row above it reads as a different kind of row, and
 * the model list carries no indent of its own — so hierarchy here comes from
 * the rotated chevron and the panel's entrance animation, the two signals that
 * survive every row being exactly as wide as its neighbours.
 */
const ROW_CLASS =
  "flex min-h-7 w-full items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-1 text-left outline-none transition-colors duration-150 hover:bg-surface-base-hover focus-visible:bg-surface-base-hover"

function SectionHeader(props: {
  label: string
  value: string
  expanded: boolean
  /** Shows a spinner in place of the value; the section cannot be opened. */
  loading?: boolean
  disabled?: boolean
  /** Soft reason the row is inert — stays on the row, never a separate notice. */
  hint?: string
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      data-slot="harness-picker-section"
      data-expanded={props.expanded ? "true" : undefined}
      disabled={props.disabled || props.loading}
      aria-busy={props.loading}
      aria-expanded={props.expanded}
      title={props.hint}
      /*
       * The same box as the rows it opens. No held fill while expanded either —
       * the rotated chevron and the panel underneath already say which section
       * is showing, and a permanent band reads as "selected", not "open".
       */
      class={`group/section shrink-0 disabled:pointer-events-none disabled:opacity-45 ${ROW_CLASS}`}
      onClick={props.onToggle}
    >
      {/* Full-strength icon: at `icon-weak` it fades into a dark surface, and
          it is the only thing telling you the row opens. */}
      <Icon
        name="chevron-right"
        size="small"
        class="shrink-0 text-icon-base transition-transform duration-200 ease-out group-data-[expanded=true]/section:rotate-90"
      />
      {/* The label is what you scan for, so it carries the weight; the value is
          the answer it currently holds and steps back — a dim label under a
          bright value would read as the row's value with a caption attached.
          Sentence case, not caps: uppercase plus wide tracking turns a
          one-word label into a legal heading. */}
      <span class="shrink-0 text-compact font-medium text-text-base">{props.label}</span>
      {/* The summary fades once the panel below is showing the same thing —
          still there for orientation, no longer competing with the list. */}
      {/* Loading belongs to the section whose contents are loading, not the
          trigger — reporting it there would say the whole control is busy
          while the harness chip beside it has already switched, reading as
          the picker hanging. Here it names exactly what you are waiting for. */}
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

/** The open section's body: the surface's own column, entering from its header. */
function SectionPanel(props: { class?: string; children: JSX.Element }) {
  return (
    <div data-slot="harness-picker-panel" class={`harness-picker-panel ${props.class ?? ""}`}>
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
      {/* Trailing check, matching the model list's own selected marker so both
          lists agree on what "current" looks like. */}
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

/**
 * The harness picker's last row: the effort slider, and the fast toggle beside
 * it when the selected model has a fast tier.
 *
 * The row is always rendered, even when the harness takes no effort, so the
 * popover keeps its height as the harness changes; an unsupported slider is an
 * empty dashed well rather than a missing row.
 */
function EffortRow(props: {
  /** The selected model's levels in order, least effort first; fewer than two renders the empty well. */
  levels: string[]
  current: string
  label: (value: string) => string
  onSelect: (value: string) => void
  fast?: FastModeControl
  onFastToggle: (next: boolean) => void
}) {
  return (
    <div data-slot="harness-picker-effort-row" class="harness-picker-effort-row" data-fast={props.fast ? "true" : undefined}>
      <Show
        when={props.levels.length > 1}
        fallback={<div data-slot="harness-picker-effort" data-supported="false" class="harness-picker-effort" title="No effort control" />}
      >
        <EffortSlider levels={props.levels} current={props.current} label={props.label} onSelect={props.onSelect} />
      </Show>
      <Show when={props.fast}>
        {(fast) => (
          <button
            type="button"
            data-slot="harness-picker-fast"
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
  // Stops sit on the thumb's travel, which is inset by the thumb's half-width
  // plus the track padding on each side; mapping against the raw track width
  // lands a click between stops on the wrong one near either end.
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
      data-slot="harness-picker-effort"
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
  /** Harness section. */
  harness: Accessor<H | undefined>
  harnessOptions: readonly H[]
  harnessLabel: (harness: H) => string
  harnessSelected?: (option: H, current: H | undefined) => boolean
  /**
   * Groups the harness rows. Not decoration: operator ACP and native SDK rows
   * label as "Claude", as do the Codex and Cursor pairs, so a flat list shows
   * three sets of identical rows with no way to tell them apart. The group
   * heading ("ACP" / "Native SDK" / "Direct") is what disambiguates them.
   */
  harnessGroup: (harness: H) => string
  harnessDisabled: Accessor<boolean>
  /** Why the harness row is inert (e.g. a started session cannot switch). */
  harnessHint?: Accessor<string | undefined>
  onHarnessSelect: (harness: H) => void

  /**
   * The harness's own mark, rendered in the trigger beside the model name so
   * the footer still states which harness a session is on at a glance. Passed
   * in rather than derived here to keep this component free of harness types.
   */
  harnessIcon: (harness: H | undefined) => JSX.Element

  /** Model section — the same `PickerState` the standalone popover consumes. */
  model: Accessor<PickerState>
  modelLabel: Accessor<string>
  modelLoading: Accessor<boolean>
  modelDisabled: Accessor<boolean>
  /**
   * A failure that makes the model list meaningless — the harness could not
   * start, its option probe failed, and so on. Rendered IN PLACE of the list:
   * an empty list under a working search box says "this harness has no models",
   * which is a different and wronger claim than "loading them failed".
   */
  modelError?: Accessor<{ message: string; detail?: string; action?: { label: string; run: () => void } } | undefined>

  /** Effort slider. An empty well when the harness offers no variants. */
  showEffort: Accessor<boolean>
  variants: Accessor<string[]>
  currentVariant: Accessor<string | undefined>
  variantLabel: (value: string) => string
  onVariantSelect: (value: string) => void
  /** The selected model's fast tier; absent hides the toggle. */
  fast?: Accessor<FastModeControl | undefined>
  onFastToggle?: (next: boolean) => void

  triggerStyle?: Accessor<JSX.CSSProperties>
  triggerLabel?: string
  /**
   * Soft, non-actionable reason the control is inert ("Model list may be
   * outdated"). Rides `title` BARE — the accessible name is a separate string,
   * because a hint reworded into a command name is no longer the hint anything
   * else in the app asserts on.
   */
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
  // Opens on the model list: the harness is almost always already right, and
  // making the common case cost a click is how these menus get slow.
  const [section, setSection] = createSignal<HarnessModelPickerSection | null>("model")

  // Clicking the OPEN header closes it. An accordion whose sections can only
  // be swapped, never shut, gives you no way to see both current values at
  // once — which is the one thing the collapsed state is good at.
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
  // Only a NON-default effort earns space in the trigger. "Default" restates
  // the absence of a choice, and the chip already carries a harness mark, a
  // model name and a chevron — a fourth token that says nothing is what makes
  // these controls read as cluttered.
  const effortInTrigger = createMemo(() => {
    const current = props.currentVariant()
    return current && current !== "default" ? props.variantLabel(current) : undefined
  })

  return (
    <Kobalte
      open={open()}
      onOpenChange={(next) => {
        setOpen(next)
        // Reopen on the model list rather than wherever the last visit ended —
        // a menu that remembers a disclosure the user has since forgotten about
        // opens "wrong" far more often than it opens helpfully.
        if (!next) setSection("model")
      }}
      modal={false}
      // `top-end`, anchoring the popover's RIGHT edge to the trigger's.
      //
      // Not cosmetic. The composer's controls sit in an `ml-auto` group, so the
      // trigger's right edge is the fixed one and its LEFT edge moves whenever
      // the model name's length changes. Under `top-start` the popover followed
      // that moving edge — and worse, at 304px it often overflowed the viewport
      // and got collision-shifted back, so the position was sometimes
      // start-anchored and sometimes not. Switching harness appeared to move
      // and resize the menu. Anchoring the stable edge makes it deterministic.
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
        {/* The harness mark, always. Loading is reported by the Model section
            inside the popover, where it names what is actually loading — a
            spinner out here claimed the whole control was busy when only the
            model list was. */}
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
          // Height is conditional, and it has to be, because the two states want
          // opposite things. Open: a DEFINITE 320px, so the list panel's
          // `flex-1` has something to grow into — under `max-h` alone a flex
          // child only ever gets its content height, which starved the list to
          // two rows while the surface sat half empty. Closed: no height at
          // all, so three headers hug instead of floating above 250px of
          // nothing.
          classList={{
            [`${COMPOSER_MENU_CLASS} claxedo-composer-menu-picker harness-picker-surface z-[260] flex flex-col gap-0.5 overflow-hidden outline-none`]: true,
            // The model list is the one section worth real estate — it is
            // searchable and routinely 100+ rows, where the harness list is
            // short and would just sit in whitespace at this size.
            "h-[26rem]": section() === "model",
            "h-80": section() === "harness",
          }}
          onOpenAutoFocus={(event) => {
            // The model list autofocuses its own search box; letting the
            // container take focus first steals the first keystroke.
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
                            // The point of the accordion: choosing a harness
                            // hands you the list it just produced, one motion.
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
          {/* Not merely hidden while loading — an empty list that fills in under
              the cursor is how you mis-click a model. The section opens once
              there is something to open. */}
          <Show when={section() === "model" && !props.modelLoading()}>
            <SectionPanel class="flex min-h-0 flex-1 flex-col">
              <Show
                when={props.modelError?.()}
                fallback={<ModelList model={props.model()} tooltips={false} onSelect={() => setOpen(false)} />}
              >
                {(failure) => (
                  <div data-slot="harness-picker-model-error" class="flex min-h-0 flex-1 flex-col items-start gap-2 px-3 py-4">
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
