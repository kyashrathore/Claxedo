import { For, Show, createMemo, createSignal, type Accessor, type JSX } from "solid-js"
import { Popover as Kobalte } from "@kobalte/core/popover"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { useLanguage } from "@/platform/i18n/provider"
import { loadManageModelsDialog } from "@/features/session/app-ports"
import { ModelList, type PickerState } from "@/features/session/ui/model/select-model"
import { COMPOSER_MENU_CLASS } from "@/features/session/composer/ui/menu-metrics"

/**
 * One chip, one popover, three questions — harness, model, effort.
 *
 * The composer dock used to spend three separate chips on these, which read as
 * three unrelated settings when they are in fact one decision made in order:
 * the harness decides which models exist, and the model decides whether effort
 * is offered at all. An accordion states that order literally — pick a harness
 * and it folds shut, handing you the model list it just produced.
 *
 * Exactly one section is open. That is what keeps the popover a FIXED height
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
 * The model section hosts the REAL `ModelList` — same search, provider
 * grouping, tags and `model_selected` commit point as the standalone picker,
 * including its connect-provider and manage-models actions. Nothing forks.
 */

export type HarnessModelPickerSection = "harness" | "model" | "effort"

/**
 * Panel inset. A 6px step past the header's own `px-1.5` edge — enough to read
 * as "indented under that row", not enough to matter.
 *
 * This was 24px (aligning content with the header LABEL, past the chevron
 * column) and that was too greedy: the popover is 304px wide, so every model
 * row paid 8% of the surface for a hierarchy cue that the held header
 * background and the entrance animation already carry between them. The indent
 * is the third and weakest of the three signals, so it is the one that yields.
 */
const PANEL_INSET = "pl-3"

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
      class="group/section flex w-full shrink-0 items-center gap-2 rounded-md px-1.5 py-1.5 text-left outline-none transition-colors duration-150 hover:bg-surface-base-hover focus-visible:bg-surface-base-hover disabled:pointer-events-none disabled:opacity-45 data-[expanded=true]:bg-surface-base-hover"
      onClick={props.onToggle}
    >
      {/* Full-strength icon. At `icon-weak` on a dark surface this chevron was
          the single most-missed control in the menu — it is the only thing
          telling you the row opens. */}
      <Icon
        name="chevron-right"
        size="small"
        class="shrink-0 text-icon-base transition-transform duration-200 ease-out group-data-[expanded=true]/section:rotate-90"
      />
      <span class="shrink-0 text-[11px] font-medium uppercase tracking-[0.06em] text-text-weaker">{props.label}</span>
      {/* The summary fades once the panel below is showing the same thing —
          still there for orientation, no longer competing with the list. */}
      {/* Loading belongs to the SECTION whose contents are loading, not to the
          trigger. In the trigger it reported the whole control as busy while
          the harness chip beside it was already switched, which read as the
          picker hanging; here it names exactly what you are waiting for. */}
      <span class="flex min-w-0 flex-1 items-center justify-end gap-1.5">
        <Show when={props.loading}>
          <span
            aria-hidden="true"
            class="size-3 shrink-0 animate-spin rounded-full border border-border-base border-t-transparent"
          />
        </Show>
        <span
          class="min-w-0 truncate text-right text-[13px] transition-colors duration-150"
          classList={{
            "text-text-base": !props.expanded && !props.loading,
            "text-text-weaker": props.expanded || props.loading,
          }}
        >
          {props.loading ? "Loading…" : props.value}
        </span>
      </span>
    </button>
  )
}

/**
 * The open section's body: inset to the header label, entering from it.
 *
 * `flush` drops the inset and cancels the surface padding so the panel runs
 * edge to edge. The model list wants that — its search bar and footer are
 * full-width rules in the upstream picker, and an inset turns them into a card
 * floating inside the menu instead of the menu's own content.
 */
function SectionPanel(props: { class?: string; flush?: boolean; children: JSX.Element }) {
  return (
    <div
      data-slot="harness-picker-panel"
      data-flush={props.flush ? "true" : undefined}
      class={`harness-picker-panel ${props.flush ? "" : PANEL_INSET} ${props.class ?? ""}`}
    >
      {props.children}
    </div>
  )
}

function OptionRow(props: { selected: boolean; icon?: JSX.Element; label: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      aria-current={props.selected ? "true" : undefined}
      class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] outline-none transition-colors duration-100 hover:bg-surface-base-hover focus-visible:bg-surface-base-hover"
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
      {/* Trailing check, matching the model list's own selected marker so all
          three sections agree on what "current" looks like. */}
      <Icon
        name="check"
        size="small"
        class="shrink-0 text-icon-base"
        classList={{ invisible: !props.selected }}
      />
    </button>
  )
}

/**
 * The model list plus its in-header manage action. Extracted so the Model
 * section can swap the WHOLE list out for a failure state — the two are
 * alternatives, never stacked.
 */
function ModelListPanel(props: {
  model: Accessor<PickerState>
  onSelect: () => void
  manage?: () => void
  manageLabel: string
}) {
  return (
    <ModelList
      model={props.model()}
      tooltips={false}
      surface="composer"
      onSelect={props.onSelect}
      action={props.manage ? (
        /* In the search row, opposite the magnifier and dimmed to match it.
           This action belongs to the list it filters, so it rides the list's
           own header rather than becoming a row. `--overlay-icon-muted` and
           `size-5` are the lens's own treatment; the button hugs the glyph so
           the search row's 10px inline padding lands it symmetrically. */
        <button
          type="button"
          data-slot="harness-picker-manage"
          aria-label={props.manageLabel}
          title={props.manageLabel}
          class="flex shrink-0 items-center text-[var(--overlay-icon-muted)] outline-none transition-colors duration-100 hover:text-[var(--overlay-icon)] focus-visible:text-[var(--overlay-icon)]"
          onClick={props.manage}
        >
          <Icon name="sliders" size="small" class="size-5 shrink-0" />
        </button>
      ) : undefined}
    />
  )
}

export function HarnessModelPicker<H extends string>(props: {
  /** Harness section. */
  harness: Accessor<H>
  harnessOptions: readonly H[]
  harnessLabel: (harness: H) => string
  /**
   * Groups the harness rows. NOT decoration: `claude-acp` and `claude-sdk` both
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
  harnessIcon: (harness: H) => JSX.Element

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
  /**
   * Whether this harness's model catalog can be managed from here. Only
   * opencode and pi expose a manage-models dialog; the ACP/SDK harnesses take
   * their model list from the runtime, so the action would be a dead end.
   */
  showManageModels: Accessor<boolean>

  /** Effort section. Omitted entirely when the harness offers no variants. */
  showEffort: Accessor<boolean>
  variants: Accessor<string[]>
  currentVariant: Accessor<string | undefined>
  variantLabel: (value: string) => string
  onVariantSelect: (value: string) => void

  triggerStyle?: Accessor<JSX.CSSProperties>
  triggerLabel?: string
  /**
   * Soft, non-actionable reason the control is inert ("Model list may be
   * outdated"). Rides `title` BARE — the accessible name is a separate string,
   * because a hint reworded into a command name is no longer the hint anything
   * else in the app asserts on.
   */
  triggerHint?: Accessor<string | undefined>
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const [open, setOpen] = createSignal(false)
  // Opens on the model list: the harness is almost always already right, and
  // making the common case cost a click is how these menus get slow.
  const [section, setSection] = createSignal<HarnessModelPickerSection | null>("model")

  // Clicking the OPEN header closes it. An accordion whose sections can only
  // be swapped, never shut, gives you no way to see all three current values at
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
  const effortValue = createMemo(() => props.variantLabel(currentVariant()))
  // Only a NON-default effort earns space in the trigger. "Default" restates
  // the absence of a choice, and the chip already carries a harness mark, a
  // model name and a chevron — a fourth token that says nothing is what makes
  // these controls read as cluttered.
  const effortInTrigger = createMemo(() => {
    const current = props.currentVariant()
    return current && current !== "default" ? props.variantLabel(current) : undefined
  })

  const handleManage = () => {
    setOpen(false)
    void loadManageModelsDialog().then((x) => {
      dialog.show(() => <x.DialogManageModels />)
    })
  }

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
            // searchable and routinely 100+ rows, where harness and effort are
            // short fixed lists that would just sit in whitespace at this size.
            "h-[26rem]": section() === "model",
            "h-80": section() === "harness" || section() === "effort",
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
            value={props.harnessLabel(props.harness())}
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
                    <div class="px-2 pb-0.5 pt-2 text-[11px] font-medium uppercase tracking-[0.06em] text-text-weaker first:pt-0.5">
                      {group}
                    </div>
                    <For each={options}>
                      {(option) => (
                        <OptionRow
                          selected={option === props.harness()}
                          icon={props.harnessIcon(option)}
                          label={props.harnessLabel(option)}
                          onSelect={() => {
                            if (option !== props.harness()) props.onHarnessSelect(option)
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
            <SectionPanel flush class="flex min-h-0 flex-1 flex-col">
              <Show
                when={props.modelError?.()}
                fallback={
                  <ModelListPanel
                    model={props.model}
                    onSelect={() => setOpen(false)}
                    manage={props.showManageModels() ? handleManage : undefined}
                    manageLabel={language.t("dialog.model.manage")}
                  />
                }
              >
                {(failure) => (
                  <div data-slot="harness-picker-model-error" class="flex min-h-0 flex-1 flex-col items-start gap-2 px-3 py-4">
                    <div class="flex items-center gap-2">
                      <span aria-hidden="true" class="size-1.5 shrink-0 rounded-full bg-icon-critical-base" />
                      <span class="text-[13px] font-medium text-text-base">{failure().message}</span>
                    </div>
                    <Show when={failure().detail}>
                      <p class="line-clamp-3 text-[12px] leading-snug text-text-weak" title={failure().detail}>
                        {failure().detail}
                      </p>
                    </Show>
                    <Show when={failure().action}>
                      {(action) => (
                        <button
                          type="button"
                          class="mt-0.5 rounded-md px-2 py-1 text-[13px] text-text-base outline-none transition-colors duration-100 hover:bg-surface-base-hover focus-visible:bg-surface-base-hover"
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

          <Show when={props.showEffort()}>
            <SectionHeader
              label="Effort"
              value={effortValue()}
              expanded={section() === "effort"}
              onToggle={() => toggle("effort")}
            />
            <Show when={section() === "effort"}>
              <SectionPanel class="min-h-0 flex-1 overflow-y-auto">
                <For each={props.variants()}>
                  {(value) => (
                    <OptionRow
                      selected={value === currentVariant()}
                      label={props.variantLabel(value)}
                      onSelect={() => {
                        if (value !== currentVariant()) props.onVariantSelect(value)
                        setOpen(false)
                      }}
                    />
                  )}
                </For>
              </SectionPanel>
            </Show>
          </Show>
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}
