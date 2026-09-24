import { Show, createMemo, createSignal, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import type { GitRefs } from "@/server"
import { ClaxedoIcon as Icon, Popover } from "@/ui"
import { dictionary, type ReviewKey } from "../i18n"
import { isBaseReviewMode, shortRef, type ReviewMode } from "../intent"
import { CompareList, type CompareOption } from "./compare-list"

export type CompareMenuProps = {
  readonly mode: ReviewMode
  readonly fromRef: string
  readonly toRef: string
  readonly currentBranch?: string
  readonly defaultBaseRef?: string
  readonly refs: GitRefs
  readonly onApplyMode: (mode: ReviewMode, fromRef: string, toRef: string) => void
  readonly hasReview: boolean
  readonly reviewCount: number
  readonly scopeLabel: string
}

const MODE_LABEL: Readonly<Record<ReviewMode, ReviewKey>> = {
  uncommitted: "review.mode.uncommitted",
  unstaged: "review.mode.unstaged",
  staged: "review.mode.staged",
  "to-from": "review.mode.toFrom",
  branch: "review.mode.branch",
  "branch-worktree": "review.mode.branchWorktree",
}

function refOptions(refs: GitRefs, exclude?: string): CompareOption[] {
  const branches = refs.branches.filter((branch) => branch !== exclude)
  return [
    ...branches
      .filter((branch) => !branch.startsWith("origin/"))
      .map((ref) => ({ kind: "ref", ref, group: "branches" }) as const),
    ...branches
      .filter((branch) => branch.startsWith("origin/"))
      .map((ref) => ({ kind: "ref", ref, group: "remote" }) as const),
    ...refs.tags.filter((tag) => tag !== exclude).map((ref) => ({ kind: "ref", ref, group: "tags" }) as const),
  ]
}

const headerButtonClass =
  "flex min-w-0 items-center gap-1 rounded-md px-1.5 h-6 text-11-regular text-text-weak hover:text-text-base hover:bg-surface-base-hover transition-colors"

function createCompareOptions(props: CompareMenuProps, base: () => string | undefined) {
  const t = useTranslator(dictionary)
  const options = createMemo((): CompareOption[] => {
    const ref = base()
    return [
      { kind: "mode", mode: "uncommitted", label: t("review.scope.uncommitted") },
      { kind: "mode", mode: "staged", label: t("review.scope.staged") },
      { kind: "mode", mode: "unstaged", label: t("review.scope.unstaged") },
      ...(ref
        ? ([
            { kind: "mode", mode: "branch", label: t("review.scope.branch") },
            { kind: "mode", mode: "branch-worktree", label: t("review.scope.since", { ref: shortRef(ref) }) },
          ] as const)
        : []),
      ...refOptions(props.refs),
      ...props.refs.recent.map((commit) => ({ kind: "commit", ref: commit.hash, subject: commit.subject }) as const),
    ]
  })
  const baseOptions = createMemo((): CompareOption[] => {
    const fallback = props.defaultBaseRef
    return [
      ...(fallback ? [{ kind: "ref", ref: fallback, group: "default" } as const] : []),
      ...refOptions(props.refs, fallback),
    ]
  })
  return { options, baseOptions }
}

function CompareTrigger(props: CompareMenuProps & { readonly comparing: boolean }): JSX.Element {
  const t = useTranslator(dictionary)
  const headLabel = () =>
    (props.toRef === "HEAD" || !props.toRef) && props.currentBranch && props.currentBranch !== "HEAD"
      ? props.currentBranch
      : shortRef(props.toRef || "HEAD")
  return (
    <>
      <Show
        when={props.comparing}
        fallback={
          <>
            <span class="leading-none">{t(MODE_LABEL[props.mode])}</span>
            <Show when={props.hasReview}>
              <span class="text-xs tabular-nums font-medium leading-none text-text-weak">{props.reviewCount}</span>
            </Show>
          </>
        }
      >
        <span class="shrink-0 leading-none">{shortRef(props.fromRef)}</span>
        <Icon name="arrow-right" size="small" class="shrink-0 text-text-weak [&_[data-slot=icon-svg]]:!size-3" />
        <span class="min-w-0 truncate leading-none">
          {props.mode === "branch-worktree" ? t("review.compare.workingTree") : headLabel()}
        </span>
      </Show>
      <Icon name="chevron-down" size="small" class="shrink-0 -ml-0.5 text-text-weak [&_[data-slot=icon-svg]]:!size-3" />
    </>
  )
}

export function CompareMenu(props: CompareMenuProps): JSX.Element {
  const t = useTranslator(dictionary)
  const comparing = () => props.mode === "to-from" || isBaseReviewMode(props.mode)
  const base = () => (isBaseReviewMode(props.mode) ? props.fromRef : props.defaultBaseRef)
  const { options, baseOptions } = createCompareOptions(props, base)
  const [open, setOpen] = createSignal(false)
  const [view, setView] = createSignal<"compare" | "base">("compare")
  const setMenuOpen = (next: boolean) => {
    setOpen(next)
    if (!next) setView("compare")
  }
  const select = (option: CompareOption) => {
    setMenuOpen(false)
    if (option.kind === "commit") props.onApplyMode("to-from", option.ref, "HEAD")
    else if (option.kind === "ref") props.onApplyMode("branch", option.ref, "")
    else if (isBaseReviewMode(option.mode)) props.onApplyMode(option.mode, base() ?? "", "")
    else props.onApplyMode(option.mode, "", "")
  }
  const selectBase = (option: CompareOption) => {
    if (option.kind !== "ref") return
    setMenuOpen(false)
    props.onApplyMode(isBaseReviewMode(props.mode) ? props.mode : "branch", option.ref, "")
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
    <Popover
      open={open()}
      onOpenChange={setMenuOpen}
      placement="bottom-start"
      gutter={4}
      triggerAs="button"
      triggerProps={triggerProps()}
      trigger={<CompareTrigger {...props} comparing={comparing()} />}
      class="z-[200] [&_[data-slot=popover-body]]:p-0"
    >
      <Show
        when={view() === "base"}
        fallback={
          <CompareList
            testId="review-compare-menu"
            label={t("review.compare.header")}
            options={options()}
            onSelect={select}
            header={
              <>
                <span class="min-w-0 flex-1">{t("review.compare.header")}</span>
                <button
                  type="button"
                  data-testid="review-compare-base"
                  class={headerButtonClass}
                  onClick={() => setView("base")}
                >
                  <span class="min-w-0 truncate">
                    {base() ? t("review.compare.against", { ref: shortRef(base()!) }) : t("review.compare.chooseBase")}
                  </span>
                  <Icon name="chevron-down" size="small" class="shrink-0 [&_[data-slot=icon-svg]]:!size-3" />
                </button>
              </>
            }
          />
        }
      >
        <CompareList
          testId="review-base-menu"
          label={t("review.compare.base")}
          options={baseOptions()}
          onSelect={selectBase}
          header={
            <button
              type="button"
              data-testid="review-base-back"
              class={`${headerButtonClass} -ml-1.5`}
              onClick={() => setView("compare")}
            >
              <Icon name="chevron-left" size="small" class="shrink-0 [&_[data-slot=icon-svg]]:!size-3" />
              <span>{t("review.compare.base")}</span>
            </button>
          }
        />
      </Show>
    </Popover>
  )
}
