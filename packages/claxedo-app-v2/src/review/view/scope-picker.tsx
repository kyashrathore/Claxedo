import { createMemo, For, Show, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import type { DiffScope, GitRefs, PlacementId } from "@/server"
import { fetchView } from "@/files"
import { useReviewApi } from "../api"
import { t } from "../i18n"
import { useReview } from "../store"

type ScopeKind = DiffScope["kind"]

const KINDS: readonly ScopeKind[] = ["uncommitted", "staged", "unstaged", "branch", "branchWorktree", "range"]

function scopeFor(kind: ScopeKind, base: string, current: DiffScope): DiffScope {
  if (kind === "branch" || kind === "branchWorktree") return { kind, base }
  if (kind === "range") {
    const from = current.kind === "range" ? current.from : base
    const to = current.kind === "range" ? current.to : "HEAD"
    return { kind, from, to }
  }
  return { kind }
}

function refNames(refs: GitRefs | undefined): readonly string[] {
  if (!refs) return []
  return [...refs.branches, ...refs.tags, ...refs.recent.map((commit) => commit.hash)]
}

function RefSelect(props: {
  readonly label: string
  readonly value: string
  readonly options: readonly string[]
  readonly onChange: (value: string) => void
}) {
  const options = () => (props.options.includes(props.value) ? props.options : [props.value, ...props.options])
  return (
    <select
      aria-label={props.label}
      value={props.value}
      class="h-8 min-w-0 flex-1 rounded-md border border-border-weak-base bg-surface-base px-2 text-12-regular text-text-base pointer-coarse:min-h-11"
      onChange={(event) => props.onChange(event.currentTarget.value)}
    >
      <For each={options()}>{(ref) => <option value={ref}>{ref}</option>}</For>
    </select>
  )
}

export function ScopePicker(props: { readonly placementId: PlacementId }): JSX.Element {
  const api = useReviewApi()
  const review = useReview()
  const refs = useQuery(() => api.refs(props.placementId))
  const bases = useQuery(() => api.bases(props.placementId))
  const defaultBase = createMemo(() => {
    const view = fetchView(bases)
    return view.kind === "ready" ? view.data.defaultRef : undefined
  })
  const names = createMemo(() => {
    const view = fetchView(refs)
    return refNames(view.kind === "ready" ? view.data : undefined)
  })
  const scope = () => review.scope()
  const rangeScope = createMemo(() => {
    const current = scope()
    return current.kind === "range" ? current : undefined
  })
  const baseOf = () => {
    const current = scope()
    return current.kind === "branch" || current.kind === "branchWorktree" ? current.base : (defaultBase() ?? "")
  }
  const setKind = (kind: ScopeKind) => review.setScope(scopeFor(kind, baseOf(), scope()))
  return (
    <div data-component="review-scope" class="flex flex-wrap items-center gap-2 border-b border-border-weak-base px-3 py-2">
      <select
        aria-label={t("review.scope.label")}
        value={scope().kind}
        class="h-8 min-w-0 flex-1 rounded-md border border-border-weak-base bg-surface-base px-2 text-12-medium text-text-base pointer-coarse:min-h-11"
        onChange={(event) => setKind(event.currentTarget.value as ScopeKind)}
      >
        <For each={KINDS}>
          {(kind) => (
            <option value={kind} disabled={(kind === "branch" || kind === "branchWorktree") && !baseOf()}>
              {t(`review.scope.${kind}`)}
            </option>
          )}
        </For>
      </select>
      <Show when={scope().kind === "branch" || scope().kind === "branchWorktree"}>
        <RefSelect label={t("review.scope.base")} value={baseOf()} options={names()} onChange={(base) => review.setScope({ kind: scope().kind === "branchWorktree" ? "branchWorktree" : "branch", base })} />
      </Show>
      <Show when={rangeScope()}>
        {(range) => (
          <>
            <RefSelect label={t("review.scope.from")} value={range().from} options={names()} onChange={(from) => review.setScope({ kind: "range", from, to: range().to })} />
            <RefSelect label={t("review.scope.to")} value={range().to} options={["HEAD", ...names()]} onChange={(to) => review.setScope({ kind: "range", from: range().from, to })} />
          </>
        )}
      </Show>
    </div>
  )
}
