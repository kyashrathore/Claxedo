import { createMemo, For, Show, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useTranslator } from "@/i18n"
import type { DiffScope, GitRefs, PlacementId } from "@/server"
import { SegmentedControl, SegmentedControlItem } from "@/ui"
import { useReviewApi } from "../api"
import { dictionary } from "../i18n"
import { readDiffStyle } from "../model"
import { useReview } from "../store"

type ScopeKind = DiffScope["kind"]

const KINDS: readonly ScopeKind[] = ["uncommitted", "staged", "unstaged", "branch", "branchWorktree", "range"]

const SELECT = "h-8 min-w-0 flex-1 rounded-md border border-border-base bg-background-base px-2 text-sm text-text-base pointer-coarse:h-11"

function isScopeKind(value: string): value is ScopeKind {
  return (KINDS as readonly string[]).includes(value)
}

function scopeFor(kind: ScopeKind, base: string, current: DiffScope): DiffScope {
  if (kind === "branch" || kind === "branchWorktree") return { kind, base }
  if (kind === "range") return current.kind === "range" ? current : { kind, from: base, to: "HEAD" }
  return { kind }
}

function refNames(refs: GitRefs | undefined): readonly string[] {
  if (!refs) return []
  return [...refs.branches, ...refs.tags, ...refs.recent.map((commit) => commit.hash)]
}

function RefSelect(props: { readonly label: string; readonly value: string; readonly options: readonly string[]; readonly onChange: (value: string) => void }): JSX.Element {
  const options = () => (props.options.includes(props.value) ? props.options : [props.value, ...props.options])
  return (
    <select aria-label={props.label} value={props.value} class={SELECT} onChange={(event) => props.onChange(event.currentTarget.value)}>
      <For each={options()}>{(ref) => <option value={ref}>{ref}</option>}</For>
    </select>
  )
}

export function ScopePicker(props: { readonly placementId: PlacementId }): JSX.Element {
  const t = useTranslator(dictionary)
  const api = useReviewApi()
  const review = useReview()
  const refs = useQuery(() => api.refs(props.placementId))
  const bases = useQuery(() => api.bases(props.placementId))
  const names = createMemo(() => refNames(refs.data))
  const scope = () => review.scope()
  const range = createMemo(() => {
    const current = scope()
    return current.kind === "range" ? current : undefined
  })
  const base = () => {
    const current = scope()
    return current.kind === "branch" || current.kind === "branchWorktree" ? current.base : (bases.data?.defaultRef ?? "")
  }
  const setKind = (value: string) => {
    if (isScopeKind(value)) review.setScope(scopeFor(value, base(), scope()))
  }
  return (
    <div data-testid="review-toolbar" class="flex flex-wrap items-center gap-2 border-b border-border-muted px-3 py-2">
      <select aria-label={t("review.scope.label")} value={scope().kind} class={SELECT} onChange={(event) => setKind(event.currentTarget.value)}>
        <For each={KINDS}>
          {(kind) => (
            <option value={kind} disabled={(kind === "branch" || kind === "branchWorktree") && !base()}>
              {t(`review.scope.${kind}`)}
            </option>
          )}
        </For>
      </select>
      <Show when={scope().kind === "branch" || scope().kind === "branchWorktree"}>
        <RefSelect label={t("review.scope.base")} value={base()} options={names()} onChange={(next) => review.setScope({ kind: scope().kind === "branchWorktree" ? "branchWorktree" : "branch", base: next })} />
      </Show>
      <Show when={range()}>
        {(current) => (
          <>
            <RefSelect label={t("review.scope.from")} value={current().from} options={names()} onChange={(from) => review.setScope({ kind: "range", from, to: current().to })} />
            <RefSelect label={t("review.scope.to")} value={current().to} options={["HEAD", ...names()]} onChange={(to) => review.setScope({ kind: "range", from: current().from, to })} />
          </>
        )}
      </Show>
      <SegmentedControl aria-label={t("review.style.label")} value={review.style()} onChange={(value) => {
        const style = readDiffStyle(value)
        if (style) review.setStyle(style)
      }}>
        <SegmentedControlItem value="unified">{t("review.style.unified")}</SegmentedControlItem>
        <SegmentedControlItem value="split">{t("review.style.split")}</SegmentedControlItem>
      </SegmentedControl>
    </div>
  )
}
