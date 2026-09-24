import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useTranslator } from "@/i18n"
import type { Placement, PlacementId, ProjectId } from "@/server"
import { Button, Collapsible, TextInput } from "@/ui"
import { useReviewApi } from "../api"
import { dictionary } from "../i18n"
import { createFlow, runFlow } from "../model"
import { FailureText } from "./flow-notice"

export function Worktrees(props: { readonly placementId: PlacementId }): JSX.Element {
  const api = useReviewApi()
  const projectId = () => api.placement(props.placementId)?.projectId
  return <Show when={projectId()}>{(id) => <ProjectWorktrees placementId={props.placementId} projectId={id()} />}</Show>
}

function ProjectWorktrees(props: { readonly placementId: PlacementId; readonly projectId: ProjectId }): JSX.Element {
  const t = useTranslator(dictionary)
  const api = useReviewApi()
  const placements = useQuery(() => api.placementsOf(props.projectId))
  const bases = useQuery(() => api.bases(props.placementId))
  const worktrees = createMemo(() => (placements.data ?? []).filter((placement) => placement.kind === "worktree"))
  return (
    <Collapsible variant="ghost" class="shrink-0 border-t border-border-muted px-3 py-1">
      <Collapsible.Trigger class="flex min-h-8 w-full items-center gap-1 text-xs text-text-muted pointer-coarse:min-h-11">
        {t("review.worktrees")} ({worktrees().length})
        <Collapsible.Arrow />
      </Collapsible.Trigger>
      <Collapsible.Content>
        <section aria-label={t("review.worktrees")} data-testid="review-worktrees" class="flex flex-col gap-2 pb-2">
          <Show
            when={worktrees().length > 0}
            fallback={<span class="text-sm text-text-faint">{t("review.worktrees.empty")}</span>}
          >
            <ul class="flex flex-col gap-0.5">
              <For each={worktrees()}>{(placement) => <WorktreeRow placement={placement} />}</For>
            </ul>
          </Show>
          <WorktreeForm projectId={props.projectId} defaultBase={bases.data?.defaultRef ?? ""} />
        </section>
      </Collapsible.Content>
    </Collapsible>
  )
}

function WorktreeRow(props: { readonly placement: Placement }): JSX.Element {
  return (
    <li
      data-placement-id={props.placement.id}
      class="flex min-h-7 flex-wrap items-center gap-x-2 text-sm pointer-coarse:min-h-11"
    >
      <span class="text-text-base">{props.placement.label}</span>
      <Show when={props.placement.branch}>
        {(branch) => <span class="font-mono text-xs text-text-muted">{branch()}</span>}
      </Show>
    </li>
  )
}

function WorktreeForm(props: { readonly projectId: ProjectId; readonly defaultBase: string }): JSX.Element {
  const t = useTranslator(dictionary)
  const api = useReviewApi()
  const flow = createFlow<"creating", Placement>()
  const [name, setName] = createSignal("")
  const [base, setBase] = createSignal("")
  const baseRef = () => base() || props.defaultBase
  const create = () =>
    runFlow(flow, "creating", async () => {
      const created = await api.createWorktree(props.projectId, {
        name: name().trim() || undefined,
        baseRef: baseRef() || undefined,
      })
      setName("")
      return created
    })
  const createdLabel = () => {
    const state = flow.state()
    return state.kind === "done" ? state.result.label : undefined
  }
  const failed = () => {
    const state = flow.state()
    return state.kind === "failed" ? state.error : undefined
  }
  return (
    <form
      aria-label={t("review.worktrees.new")}
      class="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (flow.state().kind !== "running") void create()
      }}
    >
      <div class="flex flex-wrap gap-2">
        <TextInput
          class="min-w-0 flex-1"
          value={name()}
          placeholder={t("review.worktrees.name")}
          aria-label={t("review.worktrees.name")}
          onInput={(event) => setName(event.currentTarget.value)}
        />
        <TextInput
          class="min-w-0 flex-1 font-mono"
          value={baseRef()}
          placeholder={t("review.worktrees.base")}
          aria-label={t("review.worktrees.base")}
          onInput={(event) => setBase(event.currentTarget.value)}
        />
      </div>
      <Button
        type="submit"
        size="normal"
        variant="outline"
        class="self-start"
        disabled={flow.state().kind === "running"}
      >
        {flow.state().kind === "running" ? t("review.worktrees.creating") : t("review.worktrees.create")}
      </Button>
      <div role="status" class="text-xs text-text-muted">
        <Show when={createdLabel()}>{(label) => <span>{t("review.worktrees.created", { label: label() })}</span>}</Show>
        <Show when={failed()}>{(error) => <FailureText error={error()} />}</Show>
      </div>
    </form>
  )
}
