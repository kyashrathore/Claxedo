import { Show, For, createMemo } from "solid-js"
import { Portal } from "solid-js/web"
import { Tooltip } from "@opencode-ai/ui/tooltip"

import { DiffChanges } from "@opencode-ai/ui/diff-changes"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useLanguage } from "@/platform/i18n/provider"
import { reviewModeLabel, type ReviewMode } from "@/features/review/review-intent"
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

const menuItemClass = "min-w-0 [&_[data-slot=dropdown-menu-item-label]]:min-w-0 [&_[data-slot=dropdown-menu-item-label]]:truncate"

function CompareGroup(props: { label: string; refs: string[]; onSelect: (ref: string) => void }) {
  return (
    <Show when={props.refs.length > 0}>
      <DropdownMenu.Group>
        <DropdownMenu.GroupLabel>{props.label}</DropdownMenu.GroupLabel>
        <For each={props.refs}>
          {(ref) => (
            <DropdownMenu.Item class={menuItemClass} data-ref={ref} onSelect={() => props.onSelect(ref)}>
              <DropdownMenu.ItemLabel>{ref}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
          )}
        </For>
      </DropdownMenu.Group>
    </Show>
  )
}

function ReviewToolbarBody(props: ReviewToolbarProps) {
  const comparing = () => props.mode === "to-from"
  const headLabel = () =>
    props.toRef === "HEAD" && props.currentBranch && props.currentBranch !== "HEAD" ? props.currentBranch : props.toRef
  const localBranches = createMemo(() => props.vcsRefs.branches.filter((branch) => !branch.startsWith("origin/")))
  const remoteBranches = createMemo(() => props.vcsRefs.branches.filter((branch) => branch.startsWith("origin/")))
  const compareTo = (ref: string) => props.onApplyMode("to-from", ref, "HEAD")

  return (
    <div class="contents">
      <div class="flex items-center gap-2 min-w-0">
        <DropdownMenu placement="bottom-start" gutter={4}>
          <DropdownMenu.Trigger
            data-testid="review-compare-trigger"
            data-review-mode={props.mode}
            title={props.scopeLabel}
            class="flex min-w-0 max-w-full items-center gap-1.5 h-7 px-2 text-12-medium text-text-base bg-surface-base hover:bg-surface-base-hover rounded-md transition-[background-color,color,transform] active:scale-[0.96]"
          >
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
              <span class="shrink-0 leading-none">{props.fromRef}</span>
              <Icon name="arrow-right" size="small" class="shrink-0 text-text-weak [&_[data-slot=icon-svg]]:!size-3" />
              <span class="min-w-0 truncate leading-none">{headLabel()}</span>
            </Show>
            <Icon name="chevron-down" size="small" class="shrink-0 -ml-0.5 text-text-weak [&_[data-slot=icon-svg]]:!size-3" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content data-testid="review-compare-menu" class="z-[200] max-h-96 w-[280px] overflow-y-auto">
              <DropdownMenu.Item data-testid="review-compare-uncommitted" onSelect={() => props.onApplyMode("uncommitted", "", "")}>
                <DropdownMenu.ItemLabel>Uncommitted changes</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Group>
                <DropdownMenu.GroupLabel class="text-text-base">Compare against</DropdownMenu.GroupLabel>
                <CompareGroup label="Branches" refs={localBranches()} onSelect={compareTo} />
                <CompareGroup label="Remote branches" refs={remoteBranches()} onSelect={compareTo} />
                <CompareGroup label="Tags" refs={props.vcsRefs.tags} onSelect={compareTo} />
                <Show when={props.vcsRefs.recent.length > 0}>
                  <DropdownMenu.Group>
                    <DropdownMenu.GroupLabel>Commits</DropdownMenu.GroupLabel>
                    <For each={props.vcsRefs.recent}>
                      {(commit) => (
                        <DropdownMenu.Item class={menuItemClass} data-ref={commit.hash} onSelect={() => compareTo(commit.hash)}>
                          <span class="shrink-0 font-mono text-11-regular text-text-weak">{commit.hash}</span>
                          <DropdownMenu.ItemLabel>{commit.subject}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                      )}
                    </For>
                  </DropdownMenu.Group>
                </Show>
              </DropdownMenu.Group>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu>
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
