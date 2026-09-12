import { Show, For, createMemo, createSignal, createUniqueId } from "solid-js"
import { Portal } from "solid-js/web"
import { Tooltip } from "@opencode-ai/ui/tooltip"

import { DiffChanges } from "@opencode-ai/ui/diff-changes"
import { Popover } from "@opencode-ai/ui/popover"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useLanguage } from "@/platform/i18n/provider"
import { reviewModeLabel, shortRef, type ReviewMode } from "@/features/review/review-intent"
import { reviewControlsSlot, reviewToolbarSlot } from "@/ui/controls/portal-slot"

export type { VcsRefs } from "@/platform/runtime/workspace-diff-client"
import type { VcsRefs } from "@/platform/runtime/workspace-diff-client"

export type ReviewToolbarProps = {
  mode: ReviewMode
  fromRef: string
  toRef: string
  currentBranch?: string
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

export function ReviewToolbar(props: ReviewToolbarProps) {
  // B3.4: when the L2 strip is mounted, portal the toolbar into its
  // review contextual subtree so the controls live in the persistent
  // header instead of the canvas. When no slot is registered (older
  // layouts, unit tests), render in place — graceful degradation.
  const slot = reviewToolbarSlot
  return (
    <Show
      when={slot()}
      fallback={(
        <div class="sticky top-0 shrink-0 px-3 py-1.5 flex items-center gap-2 text-13-medium z-10">
          <ReviewToolbarBody {...props} />
        </div>
      )}
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
    props.diffStyle === "split" ? language.t("ui.sessionReview.diffStyle.unified") : language.t("ui.sessionReview.diffStyle.split")
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
          aria-pressed={props.diffStyle === "split"}
          onClick={() => props.onSetDiffStyle(props.diffStyle === "split" ? "unified" : "split")}
        >
          <Icon name={props.diffStyle === "split" ? "unified" : "split"} size="small" />
        </button>
      </Tooltip>
    </div>
  )
}

type CompareOption =
  | { kind: "uncommitted" }
  | { kind: "ref"; ref: string; group: "branches" | "remote" | "tags" }
  | { kind: "commit"; ref: string; subject: string }

const COMPARE_GROUP_LABEL = {
  branches: "Branches",
  remote: "Remote branches",
  tags: "Tags",
  commits: "Commits",
} as const

function optionRef(option: CompareOption) {
  return option.kind === "uncommitted" ? "" : option.ref
}

function optionMatchesQuery(option: CompareOption, query: string) {
  if (option.kind === "uncommitted" || query.length === 0) return true
  if (option.ref.toLowerCase().includes(query)) return true
  return option.kind === "commit" && option.subject.toLowerCase().includes(query)
}

function optionGroup(option: CompareOption) {
  if (option.kind === "uncommitted") return undefined
  return option.kind === "commit" ? "commits" : option.group
}

/**
 * The compare picker: a text filter over every ref, then the refs as one
 * listbox the filter's arrow keys walk. Not a menu: a menu's typeahead claims
 * printable keys, which the filter field needs.
 */
function CompareList(props: {
  options: CompareOption[]
  onSelect: (option: CompareOption) => void
}) {
  const language = useLanguage()
  const listId = createUniqueId()
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal(0)
  const normalizedQuery = () => query().trim().toLowerCase()
  const visible = createMemo(() => props.options.filter((option) => optionMatchesQuery(option, normalizedQuery())))
  const activeOption = () => visible()[Math.min(active(), visible().length - 1)]
  const optionId = (index: number) => `${listId}-option-${index}`
  const noMatches = () => normalizedQuery().length > 0 && visible().every((option) => option.kind === "uncommitted")

  const move = (delta: number) => {
    const count = visible().length
    if (count === 0) return
    setActive((current) => (Math.min(current, count - 1) + delta + count) % count)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") move(1)
    else if (event.key === "ArrowUp") move(-1)
    else if (event.key === "Home") setActive(0)
    else if (event.key === "End") setActive(Math.max(visible().length - 1, 0))
    else if (event.key === "Enter") {
      const option = activeOption()
      if (option) props.onSelect(option)
    } else return
    event.preventDefault()
  }

  return (
    <div data-testid="review-compare-menu" class="flex max-h-96 w-[280px] flex-col">
      <input
        data-testid="review-compare-search"
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-autocomplete="list"
        aria-controls={listId}
        aria-activedescendant={activeOption() ? optionId(visible().indexOf(activeOption())) : undefined}
        autocomplete="off"
        spellcheck={false}
        placeholder={language.t("navigator.sourceControl.compare.search.placeholder")}
        class="mx-1.5 mt-1.5 h-7 shrink-0 rounded-md border border-border-weak-base bg-surface-base px-2 text-12-regular text-text-base outline-none placeholder:text-text-weaker focus:border-border-base"
        value={query()}
        onInput={(event) => {
          setQuery(event.currentTarget.value)
          setActive(0)
        }}
        onKeyDown={onKeyDown}
      />
      <div id={listId} role="listbox" aria-label="Compare against" class="min-h-0 overflow-y-auto p-1">
        <For each={visible()}>
          {(option, index) => {
            const group = optionGroup(option)
            const first = () => {
              const previous = visible()[index() - 1]
              return !!group && (!previous || optionGroup(previous) !== group)
            }
            return (
              <>
                <Show when={option.kind === "uncommitted"}>
                  <div class="px-2 pt-1.5 pb-1 text-11-regular text-text-base">Compare against</div>
                </Show>
                <Show when={first()}>
                  <div class="px-2 pt-2 pb-1 text-11-regular text-text-weaker">{COMPARE_GROUP_LABEL[group!]}</div>
                </Show>
                <div
                  id={optionId(index())}
                  role="option"
                  aria-selected={activeOption() === option}
                  data-testid={option.kind === "uncommitted" ? "review-compare-uncommitted" : undefined}
                  data-ref={optionRef(option) || undefined}
                  class="flex h-7 min-w-0 cursor-default items-center gap-2 rounded-md px-2 text-12-regular text-text-base hover:bg-surface-base-hover aria-selected:bg-surface-base-hover"
                  onMouseMove={() => setActive(index())}
                  onClick={() => props.onSelect(option)}
                >
                  <Show when={option.kind === "commit" && option}>
                    {(commit) => <span class="shrink-0 font-mono text-11-regular text-text-weak">{shortRef(commit().ref)}</span>}
                  </Show>
                  <span class="min-w-0 flex-1 truncate">
                    {option.kind === "uncommitted" ? "Uncommitted changes" : option.kind === "commit" ? option.subject : option.ref}
                  </span>
                </div>
              </>
            )
          }}
        </For>
        <Show when={noMatches()}>
          <div data-testid="review-compare-no-matches" class="px-2 py-2 text-12-regular text-text-weak">
            {language.t("navigator.sourceControl.compare.noMatches")}
          </div>
        </Show>
      </div>
    </div>
  )
}

function ReviewToolbarBody(props: ReviewToolbarProps) {
  const comparing = () => props.mode === "to-from"
  const headLabel = () =>
    props.toRef === "HEAD" && props.currentBranch && props.currentBranch !== "HEAD" ? props.currentBranch : shortRef(props.toRef)
  const options = createMemo((): CompareOption[] => [
    { kind: "uncommitted" },
    ...props.vcsRefs.branches.filter((branch) => !branch.startsWith("origin/")).map((ref) => ({ kind: "ref", ref, group: "branches" }) as const),
    ...props.vcsRefs.branches.filter((branch) => branch.startsWith("origin/")).map((ref) => ({ kind: "ref", ref, group: "remote" }) as const),
    ...props.vcsRefs.tags.map((ref) => ({ kind: "ref", ref, group: "tags" }) as const),
    ...props.vcsRefs.recent.map((commit) => ({ kind: "commit", ref: commit.hash, subject: commit.subject }) as const),
  ])
  const [open, setOpen] = createSignal(false)
  const select = (option: CompareOption) => {
    setOpen(false)
    if (option.kind === "uncommitted") props.onApplyMode("uncommitted", "", "")
    else props.onApplyMode("to-from", option.ref, "HEAD")
  }
  const triggerProps = () => ({
    type: "button" as const,
    "data-testid": "review-compare-trigger",
    "data-review-mode": props.mode,
    title: props.scopeLabel,
    class:
      "flex min-w-0 max-w-full items-center gap-1.5 h-7 px-2 text-12-medium text-text-base bg-surface-base hover:bg-surface-base-hover rounded-md transition-[background-color,color,transform] active:scale-[0.96]",
  })

  return (
    <div class="contents">
      <div class="flex items-center gap-2 min-w-0">
        <Popover
          open={open()}
          onOpenChange={setOpen}
          placement="bottom-start"
          gutter={4}
          triggerAs="button"
          triggerProps={triggerProps()}
          trigger={
            <>
              <Show
                when={comparing()}
                fallback={
                  <>
                    <span class="leading-none">{reviewModeLabel[props.mode]}</span>
                    <Show when={props.hasReview}>
                      <span class="text-xs tabular-nums font-medium leading-none text-text-weak">{props.reviewCount}</span>
                    </Show>
                  </>
                }
              >
                <span class="shrink-0 leading-none">{shortRef(props.fromRef)}</span>
                <Icon name="arrow-right" size="small" class="shrink-0 text-text-weak [&_[data-slot=icon-svg]]:!size-3" />
                <span class="min-w-0 truncate leading-none">{headLabel()}</span>
              </Show>
              <Icon name="chevron-down" size="small" class="shrink-0 -ml-0.5 text-text-weak [&_[data-slot=icon-svg]]:!size-3" />
            </>
          }
          class="z-[200] [&_[data-slot=popover-body]]:p-0"
        >
          <CompareList options={options()} onSelect={select} />
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
