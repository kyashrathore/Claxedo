import { createEffect } from "solid-js"
import { Show, For, createMemo, createSignal, untrack } from "solid-js"
import { Portal } from "@solidjs/web"
import { Tooltip } from "@opencode-ai/ui/tooltip"

import { DiffChanges } from "@opencode-ai/ui/diff-changes"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { Popover } from "@opencode-ai/ui/popover"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useLanguage } from "@/platform/i18n/provider"
import { REVIEW_POPOVER_MODES, type ReviewMode } from "@/features/review/review-intent"
import { reviewControlsSlot, reviewToolbarSlot } from "@/ui/controls/portal-slot"

export type { VcsRefs } from "@/platform/runtime/workspace-diff-client"
import type { VcsRefs } from "@/platform/runtime/workspace-diff-client"

export const reviewModeLabel: Record<ReviewMode, string> = {
  uncommitted: "Uncommitted",
  unstaged: "Unstaged",
  staged: "Staged",
  "to-from": "to / from",
}

export type ReviewToolbarProps = {
  mode: ReviewMode
  fromRef: string
  toRef: string
  vcsRefs: VcsRefs
  onApplyMode: (mode: ReviewMode, fromRef: string, toRef: string) => void
  hasReview: boolean
  loading: boolean
  reviewCount: number
  totalChanges: { additions: number; deletions: number }
  scopeLabel: string
  hasExpandedDiffs: boolean
  onToggleAllDiffs: () => void
  diffStyle: "unified" | "split"
  onSetDiffStyle: (style: "unified" | "split") => void
}

function RefPickerField(props: {
  label: string
  value: string
  onInput: (value: string) => void
  onSelect: (value: string) => void
  placeholder: string
  refs: VcsRefs
}) {
  const [open, setOpen] = createSignal(false)
  const [filter, setFilter] = createSignal("")

  const filtered = createMemo(() => {
    const q = filter().toLowerCase()
    const branches = props.refs.branches.filter((branch) => !q || branch.toLowerCase().includes(q))
    const tags = props.refs.tags.filter((tag) => !q || tag.toLowerCase().includes(q))
    const recent = props.refs.recent.filter(
      (commit) => !q || commit.hash.toLowerCase().includes(q) || commit.subject.toLowerCase().includes(q),
    )
    return { branches, tags, recent }
  })

  const hasResults = createMemo(() => {
    const refs = filtered()
    return refs.branches.length > 0 || refs.tags.length > 0 || refs.recent.length > 0
  })

  const select = (value: string) => {
    props.onSelect(value)
    setOpen(false)
    setFilter("")
  }

  return (
    <div class="flex flex-col gap-1">
      <div class="text-12-medium text-text-weak">{props.label}</div>
      <div class="relative">
        <input
          class="h-8 w-full rounded-md border border-border-weak-base bg-background-base pl-2 pr-7 text-13-regular"
          value={props.value}
          onInput={(event) => {
            props.onInput(event.currentTarget.value)
            setFilter(event.currentTarget.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder={props.placeholder}
        />
        <button
          type="button"
          class="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-text-weak hover:text-text-base"
          tabindex={-1}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setFilter("")
            setOpen((current) => !current)
          }}
        >
          <svg class="w-3 h-3" viewBox="0 0 12 12">
            <path
              d="M3 5l3 3 3-3"
              stroke="currentColor"
              stroke-width="1.5"
              fill="none"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <Show when={open() && hasResults()}>
          <div
            data-surface="overlay"
            data-overlay-shell="raised-menu"
            class="absolute left-0 right-0 top-full z-50 mt-1 max-h-52 overflow-y-auto bg-background-base"
          >
            <Show when={filtered().branches.length > 0}>
              <div class="px-2 pt-1.5 pb-0.5 text-11-medium text-text-weak uppercase tracking-wider">Branches</div>
              <For each={filtered().branches.slice(0, 15)}>
                {(branch) => (
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 px-2 py-1 text-12-regular text-text-base hover:bg-surface-base-hover truncate"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => select(branch)}
                  >
                    <svg class="w-3 h-3 shrink-0 text-text-weak" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.5 2.5 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Z" />
                    </svg>
                    <span class="truncate">{branch}</span>
                  </button>
                )}
              </For>
            </Show>
            <Show when={filtered().tags.length > 0}>
              <div class="px-2 pt-1.5 pb-0.5 text-11-medium text-text-weak uppercase tracking-wider">Tags</div>
              <For each={filtered().tags.slice(0, 10)}>
                {(tag) => (
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 px-2 py-1 text-12-regular text-text-base hover:bg-surface-base-hover truncate"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => select(tag)}
                  >
                    <svg class="w-3 h-3 shrink-0 text-text-weak" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M1 7.775V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 0 1 0 2.474l-5.026 5.026a1.75 1.75 0 0 1-2.474 0l-6.25-6.25A1.75 1.75 0 0 1 1 7.775ZM6 5a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z" />
                    </svg>
                    <span class="truncate">{tag}</span>
                  </button>
                )}
              </For>
            </Show>
            <Show when={filtered().recent.length > 0}>
              <div class="px-2 pt-1.5 pb-0.5 text-11-medium text-text-weak uppercase tracking-wider">Commits</div>
              <For each={filtered().recent}>
                {(commit) => (
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 px-2 py-1 text-12-regular text-text-base hover:bg-surface-base-hover"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => select(commit.hash)}
                  >
                    <span class="shrink-0 font-mono text-11-regular text-text-weak">{commit.hash}</span>
                    <span class="truncate">{commit.subject}</span>
                  </button>
                )}
              </For>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}

export function ReviewToolbar(props: ReviewToolbarProps) {
  // B3.4: when the L2 strip is mounted, portal the toolbar into its
  // review contextual subtree so the controls live in the persistent
  // header instead of the canvas. When no slot is registered (older
  // layouts, unit tests), render in place — graceful degradation.
  const slot = reviewToolbarSlot
  return (
    <Show
      when={slot()}
      fallback={
        <div class="sticky top-0 shrink-0 px-3 py-1.5 flex items-center gap-2 text-13-medium z-10">
          <ReviewToolbarBody {...props} />
        </div>
      }
    >
      {(host) => (
        <Portal mount={host()}>
          <div class="flex min-w-0 flex-1 items-center gap-2 text-13-medium">
            <ReviewToolbarBody {...props} />
          </div>
        </Portal>
      )}
    </Show>
  )
}

// The view controls live at the far right of the review header, immediately left
// of the Files/Changes/Processes navigator. They portal into reviewControlsSlot
// (rendered by the L2 strip beside the navigator) so their position is fixed
// there regardless of the toolbar body's flex width; falls back to inline.
function ReviewToolbarControls(props: {
  hasExpandedDiffs: boolean
  onToggleAllDiffs: () => void
  diffStyle: "unified" | "split"
  onSetDiffStyle: (style: "unified" | "split") => void
}) {
  const language = useLanguage()
  const expandLabel = () =>
    props.hasExpandedDiffs ? language.t("ui.sessionReview.collapseAll") : language.t("ui.sessionReview.expandAll")
  const viewLabel = () =>
    props.diffStyle === "split"
      ? language.t("ui.sessionReview.diffStyle.unified")
      : language.t("ui.sessionReview.diffStyle.split")
  return (
    <div class="flex shrink-0 items-center gap-0.5">
      <Tooltip value={expandLabel()} placement="bottom" gutter={4}>
        <button
          type="button"
          data-icon-interaction="binary"
          class="flex size-6 items-center justify-center rounded-sm text-text-weak hover:text-text-base hover:bg-surface-base-hover transition-colors [&_[data-slot=icon-svg]]:!size-3.5"
          aria-label={expandLabel()}
          aria-pressed={props.hasExpandedDiffs}
          onClick={props.onToggleAllDiffs}
        >
          <Icon name={props.hasExpandedDiffs ? "collapse-all" : "expand-all"} size="small" />
        </button>
      </Tooltip>
      <Tooltip value={viewLabel()} placement="bottom" gutter={4}>
        <button
          type="button"
          data-testid="review-diff-style-toggle"
          data-review-next-diff-style={props.diffStyle === "split" ? "unified" : "split"}
          data-icon-interaction="binary"
          class="flex size-6 items-center justify-center rounded-sm text-text-weak hover:text-text-base hover:bg-surface-base-hover transition-colors [&_[data-slot=icon-svg]]:!size-3.5"
          aria-label={viewLabel()}
          aria-pressed={
            (props.diffStyle === "split") == null ? undefined : props.diffStyle === "split" ? "true" : "false"
          }
          onClick={() => props.onSetDiffStyle(props.diffStyle === "split" ? "unified" : "split")}
        >
          <Icon name={props.diffStyle === "split" ? "unified" : "split"} size="small" />
        </button>
      </Tooltip>
    </div>
  )
}

function ReviewToolbarBody(props: ReviewToolbarProps) {
  const language = useLanguage()
  const [modeSelectorOpen, setModeSelectorOpen] = createSignal(false)
  const [pendingMode, setPendingMode] = createSignal<ReviewMode>(untrack(() => props.mode))
  const [pendingFromRef, setPendingFromRef] = createSignal(untrack(() => props.fromRef))
  const [pendingToRef, setPendingToRef] = createSignal(untrack(() => props.toRef))

  createEffect(
    () => modeSelectorOpen(),
    (open) => {
      if (!open) return
      setPendingMode(untrack(() => props.mode))
      setPendingFromRef(untrack(() => props.fromRef))
      setPendingToRef(untrack(() => props.toRef))
    },
  )

  const pendingCanApply = createMemo(() => {
    if (pendingMode() !== "to-from") return true
    return pendingFromRef().trim().length > 0 && pendingToRef().trim().length > 0
  })

  return (
    <div class="contents">
      <div class="flex items-center gap-2 min-w-0">
        <Popover
          placement="bottom-start"
          open={modeSelectorOpen()}
          onOpenChange={setModeSelectorOpen}
          trigger={
            <span class="flex items-center gap-1.5">
              <span class="leading-none">{reviewModeLabel[props.mode]}</span>
              <Show when={props.hasReview}>
                <span class="text-xs tabular-nums font-medium leading-none text-text-weak">{props.reviewCount}</span>
              </Show>
              <svg class="w-2.5 h-2.5 shrink-0 text-text-weak -ml-0.5" viewBox="0 0 12 12" aria-hidden="true">
                <path
                  d="M3 5l3 3 3-3"
                  stroke="currentColor"
                  stroke-width="1.5"
                  fill="none"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
          }
          triggerAs="button"
          triggerProps={{
            class:
              "flex items-center gap-1.5 h-7 px-2 text-12-medium text-text-base hover:bg-surface-base-hover rounded-md transition-[background-color,color,transform] active:scale-[0.96]",
            title: props.scopeLabel,
          }}
          class="w-[280px] [&_[data-slot=popover-body]]:p-2"
        >
          <div class="flex flex-col gap-2">
            <div class="px-1.5 pt-1 text-11-medium text-text-weak">Review source</div>

            <div class="flex flex-col">
              <div class="flex flex-col gap-0.5">
                <For each={REVIEW_POPOVER_MODES}>
                  {(mode) => (
                    <button
                      type="button"
                      class={[
                        "flex min-h-8 w-full items-center justify-between gap-3 rounded-md px-2.5 py-1 text-left text-12-medium transition-[background-color,color,transform] active:scale-[0.96]",
                        {
                          "bg-surface-base-hover text-text-strong": pendingMode() === mode,
                          "text-text-base hover:bg-surface-base-hover": pendingMode() !== mode,
                        },
                      ]}

                      onClick={() => setPendingMode(mode)}
                    >
                      <span class="truncate">{reviewModeLabel[mode]}</span>
                      <span
                        class={[
                          "flex h-5 w-5 shrink-0 items-center justify-center text-text-strong transition-[opacity,transform,filter]",
                          {
                            "scale-100 opacity-100 blur-0": pendingMode() === mode,
                            "scale-[0.25] opacity-0 blur-sm": pendingMode() !== mode,
                          },
                        ]}
                      >
                        <Icon name="check" size="small" />
                      </span>
                    </button>
                  )}
                </For>
              </div>
            </div>

            <Show when={pendingMode() === "to-from"}>
              <div class="grid grid-cols-2 gap-2">
                <RefPickerField
                  label="From"
                  value={pendingFromRef()}
                  onInput={setPendingFromRef}
                  onSelect={setPendingFromRef}
                  placeholder="HEAD~1"
                  refs={props.vcsRefs}
                />
                <RefPickerField
                  label="To"
                  value={pendingToRef()}
                  onInput={setPendingToRef}
                  onSelect={setPendingToRef}
                  placeholder="HEAD"
                  refs={props.vcsRefs}
                />
              </div>
            </Show>

            <div class="flex justify-end">
              <button
                type="button"
                class="h-8 rounded-md border border-border-weak-base bg-surface-base text-text-base text-12-medium px-4 hover:bg-surface-base-hover disabled:pointer-events-none disabled:opacity-50 transition-[background-color,border-color,color,opacity,transform] active:scale-[0.96]"
                disabled={!pendingCanApply()}
                onClick={() => {
                  props.onApplyMode(pendingMode(), pendingFromRef(), pendingToRef())
                  setModeSelectorOpen(false)
                }}
              >
                Apply
              </button>
            </div>
          </div>
        </Popover>
        <Show when={props.loading}>
          <Spinner class="h-3 w-3 shrink-0 text-text-weak" />
        </Show>
        <Show when={props.hasReview}>
          <DiffChanges
            changes={props.totalChanges}
            class="tabular-nums [&]:!gap-2 [&_[data-slot=diff-changes-additions]]:![font-family:var(--font-family-sans)] [&_[data-slot=diff-changes-deletions]]:![font-family:var(--font-family-sans)] [&_[data-slot=diff-changes-additions]]:!font-normal [&_[data-slot=diff-changes-deletions]]:!font-normal [&_[data-slot=diff-changes-additions]]:![color:color-mix(in_srgb,var(--text-diff-add-base)_82%,var(--text-weaker))] [&_[data-slot=diff-changes-deletions]]:![color:color-mix(in_srgb,var(--text-diff-delete-base)_76%,var(--text-weaker))]"
          />
        </Show>
      </div>
      <span class="flex-1 min-w-0" />
      <Show when={props.hasReview}>
        <Show
          when={reviewControlsSlot()}
          fallback={
            <div class="pl-1">
              <ReviewToolbarControls
                hasExpandedDiffs={props.hasExpandedDiffs}
                onToggleAllDiffs={props.onToggleAllDiffs}
                diffStyle={props.diffStyle}
                onSetDiffStyle={props.onSetDiffStyle}
              />
            </div>
          }
        >
          {(host) => (
            <Portal mount={host()}>
              <ReviewToolbarControls
                hasExpandedDiffs={props.hasExpandedDiffs}
                onToggleAllDiffs={props.onToggleAllDiffs}
                diffStyle={props.diffStyle}
                onSetDiffStyle={props.onSetDiffStyle}
              />
            </Portal>
          )}
        </Show>
      </Show>
    </div>
  )
}
