import { Show, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { useTranslator } from "@/i18n"
import { ClaxedoIcon as Icon, reviewControlsSlot, reviewToolbarSlot, DiffChanges, Spinner, Tooltip } from "@/ui"
import { reviewDictionary } from "../i18n"
import type { DiffStyle } from "../model"
import { CompareMenu, type CompareMenuProps } from "./compare-menu"

export type ReviewToolbarProps = CompareMenuProps & {
  readonly loading: boolean
  readonly totalChanges: { readonly additions: number; readonly deletions: number }
  readonly hasExpandedDiffs: boolean
  readonly onToggleAllDiffs: () => void
  readonly diffStyle: DiffStyle
  readonly onSetDiffStyle: (style: DiffStyle) => void
}

export function ReviewToolbar(props: ReviewToolbarProps): JSX.Element {
  return (
    <Show
      when={reviewToolbarSlot()}
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

function ReviewToolbarControls(props: {
  readonly hasExpandedDiffs: boolean
  readonly onToggleAllDiffs: () => void
  readonly diffStyle: DiffStyle
  readonly onSetDiffStyle: (style: DiffStyle) => void
}): JSX.Element {
  const t = useTranslator(reviewDictionary)
  const expandLabel = () => (props.hasExpandedDiffs ? t("review.collapseAll") : t("review.expandAll"))
  const viewLabel = () => (props.diffStyle === "split" ? t("review.style.unified") : t("review.style.split"))
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

const TOTALS_CLASS =
  "tabular-nums [&]:!gap-2 [&_[data-slot=diff-changes-additions]]:![font-family:var(--font-family-sans)] [&_[data-slot=diff-changes-deletions]]:![font-family:var(--font-family-sans)] [&_[data-slot=diff-changes-additions]]:!font-normal [&_[data-slot=diff-changes-deletions]]:!font-normal [&_[data-slot=diff-changes-additions]]:![color:color-mix(in_srgb,var(--text-diff-add-base)_82%,var(--text-weaker))] [&_[data-slot=diff-changes-deletions]]:![color:color-mix(in_srgb,var(--text-diff-delete-base)_76%,var(--text-weaker))]"

function ReviewToolbarBody(props: ReviewToolbarProps): JSX.Element {
  const controls = () => (
    <ReviewToolbarControls
      hasExpandedDiffs={props.hasExpandedDiffs}
      onToggleAllDiffs={props.onToggleAllDiffs}
      diffStyle={props.diffStyle}
      onSetDiffStyle={props.onSetDiffStyle}
    />
  )
  return (
    <div class="contents">
      <div class="flex items-center gap-2 min-w-0">
        <CompareMenu {...props} />
        <Show when={props.loading}>
          <Spinner class="h-3 w-3 shrink-0 text-text-weak" />
        </Show>
        <Show when={props.hasReview}>
          <DiffChanges changes={props.totalChanges} class={TOTALS_CLASS} />
        </Show>
      </div>
      <span class="flex-1 min-w-0" />
      <Show when={props.hasReview}>
        <Show when={reviewControlsSlot()} fallback={<div class="pl-1">{controls()}</div>}>
          {(host) => <Portal mount={host()}>{controls()}</Portal>}
        </Show>
      </Show>
    </div>
  )
}
