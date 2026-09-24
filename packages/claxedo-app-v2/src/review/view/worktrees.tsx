import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import type { Placement, PlacementId, ProjectId } from "@/server"
import { fetchView } from "@/files"
import { useReviewApi } from "../api"
import { t } from "../i18n"
import { createFlow, errorText, runFlow, type WorktreeFlow } from "../model"

export function Worktrees(props: { readonly placementId: PlacementId }): JSX.Element {
  const api = useReviewApi()
  const projectId = () => api.placement(props.placementId)?.projectId
  return (
    <Show when={projectId()}>
      {(id) => <ProjectWorktrees placementId={props.placementId} projectId={id()} />}
    </Show>
  )
}

function ProjectWorktrees(props: { readonly placementId: PlacementId; readonly projectId: ProjectId }) {
  const api = useReviewApi()
  const placements = useQuery(() => api.placementsOf(props.projectId))
  const bases = useQuery(() => api.bases(props.placementId))
  const worktrees = createMemo(() => {
    const view = fetchView(placements)
    return view.kind === "ready" ? view.data.filter((placement) => placement.kind === "worktree") : []
  })
  const defaultBase = createMemo(() => {
    const view = fetchView(bases)
    return view.kind === "ready" ? (view.data.defaultRef ?? "") : ""
  })
  return (
    <section data-component="review-worktrees" aria-label={t("review.worktrees")} class="flex flex-col gap-2 border-t border-border-weak-base px-3 py-2">
      <h3 class="text-11-regular text-text-weak">{t("review.worktrees")}</h3>
      <Show when={worktrees().length > 0} fallback={<span class="text-12-regular text-text-weaker">{t("review.worktrees.empty")}</span>}>
        <ul class="flex flex-col gap-0.5">
          <For each={worktrees()}>{(placement) => <WorktreeRow placement={placement} />}</For>
        </ul>
      </Show>
      <WorktreeForm projectId={props.projectId} defaultBase={defaultBase()} />
    </section>
  )
}

function WorktreeRow(props: { readonly placement: Placement }) {
  return (
    <li data-component="review-worktree" data-placement-id={props.placement.id} class="flex min-h-7 flex-wrap items-center gap-x-2 text-12-regular pointer-coarse:min-h-11">
      <span class="text-text-base">{props.placement.label}</span>
      <Show when={props.placement.branch}>{(branch) => <span class="font-mono text-11-regular text-text-weak">{branch()}</span>}</Show>
    </li>
  )
}

function WorktreeForm(props: { readonly projectId: ProjectId; readonly defaultBase: string }) {
  const api = useReviewApi()
  const flow = createFlow<"creating", Placement>()
  const [name, setName] = createSignal("")
  const [base, setBase] = createSignal("")
  const baseRef = () => base() || props.defaultBase
  const create = () =>
    runFlow(flow, "creating", async () => {
      const created = await api.createWorktree(props.projectId, { name: name().trim() || undefined, baseRef: baseRef() || undefined })
      setName("")
      return created
    })
  return (
    <form
      class="flex flex-col gap-2"
      aria-label={t("review.worktrees.new")}
      onSubmit={(event) => {
        event.preventDefault()
        if (flow.state().kind !== "running") void create()
      }}
    >
      <div class="flex flex-wrap gap-2">
        <input type="text" value={name()} placeholder={t("review.worktrees.name")} aria-label={t("review.worktrees.name")} class="h-8 min-w-0 flex-1 rounded-md border border-border-weak-base bg-surface-base px-2 text-12-regular text-text-base outline-none placeholder:text-text-weak focus:border-border-strong-base pointer-coarse:min-h-11" onInput={(event) => setName(event.currentTarget.value)} />
        <input type="text" value={baseRef()} placeholder={t("review.worktrees.base")} aria-label={t("review.worktrees.base")} class="h-8 min-w-0 flex-1 rounded-md border border-border-weak-base bg-surface-base px-2 font-mono text-12-regular text-text-base outline-none placeholder:text-text-weak focus:border-border-strong-base pointer-coarse:min-h-11" onInput={(event) => setBase(event.currentTarget.value)} />
      </div>
      <button type="submit" disabled={flow.state().kind === "running"} class="min-h-8 self-start rounded-md border border-border-weak-base px-3 text-12-medium text-text-base disabled:opacity-50 pointer-coarse:min-h-11">
        {flow.state().kind === "running" ? t("review.worktrees.creating") : t("review.worktrees.create")}
      </button>
      <WorktreeNotice flow={flow.state()} />
    </form>
  )
}

function WorktreeNotice(props: { readonly flow: WorktreeFlow }) {
  return (
    <div role="status" class="text-11-regular">
      <Show when={props.flow.kind === "done" && props.flow}>
        {(done) => <span class="text-text-weak">{done().kind === "done" ? t("review.worktrees.created", { label: done().result.label }) : ""}</span>}
      </Show>
      <Show when={props.flow.kind === "failed" && props.flow}>
        {(failed) => <span role="alert" class="text-icon-critical-base">{failed().kind === "failed" ? errorText(failed().error) : ""}</span>}
      </Show>
    </div>
  )
}
