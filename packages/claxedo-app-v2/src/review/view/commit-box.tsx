import { createMemo, For, Show, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useTranslator } from "@/i18n"
import { toAppError, type FileChange, type GitStatus, type PlacementId } from "@/server"
import { Button, Checkbox, Collapsible, Textarea } from "@/ui"
import { useReviewApi } from "../api"
import { dictionary } from "../i18n"
import { createFlow, runFlow } from "@/lib/flow"
import { useReview } from "../store"
import { FlowNotice } from "./flow-notice"

function changedFiles(status: GitStatus | undefined): readonly FileChange[] {
  if (!status) return []
  const seen = new Set<string>()
  return [...status.staged, ...status.unstaged].filter((change) => {
    if (seen.has(change.path)) return false
    seen.add(change.path)
    return true
  })
}

function FileChecklist(props: { readonly changes: readonly FileChange[] }): JSX.Element {
  const t = useTranslator(dictionary)
  const review = useReview()
  return (
    <Collapsible variant="ghost">
      <Collapsible.Trigger class="flex min-h-8 items-center gap-1 text-xs text-text-muted pointer-coarse:min-h-11">
        {t("review.commit.files")} ({props.changes.length})
        <Collapsible.Arrow />
      </Collapsible.Trigger>
      <Collapsible.Content>
        <div class="flex max-h-48 flex-col gap-1 overflow-auto py-1">
          <For each={props.changes}>
            {(change) => (
              <Checkbox
                checked={!review.excluded(change.path)}
                onChange={(checked: boolean) => review.setExcluded(change.path, !checked)}
                label={<span class="break-all">{change.path}</span>}
              />
            )}
          </For>
        </div>
      </Collapsible.Content>
    </Collapsible>
  )
}

export function CommitBox(props: { readonly placementId: PlacementId }): JSX.Element {
  const t = useTranslator(dictionary)
  const api = useReviewApi()
  const review = useReview()
  const status = useQuery(() => api.status(props.placementId))
  const changes = createMemo(() => changedFiles(status.data))
  const selected = () =>
    changes()
      .filter((change) => !review.excluded(change.path))
      .map((change) => change.path)
  const commit = createFlow<"staging" | "committing", { readonly hash: string }>()
  const push = createFlow<"pushing", { readonly remote: string; readonly branch: string }>()
  const canCommit = () =>
    review.message().trim().length > 0 && selected().length > 0 && commit.state().kind !== "running"
  const runCommit = () =>
    runFlow(
      commit,
      "staging",
      async (step) => {
        const staged = new Set((status.data?.staged ?? []).map((change) => change.path))
        const unstage = changes()
          .map((change) => change.path)
          .filter((path) => review.excluded(path) && staged.has(path))
        if (unstage.length > 0) await api.unstage(props.placementId, unstage)
        await api.stage(props.placementId, selected())
        step("committing")
        const result = await api.commit(props.placementId, { message: review.message().trim() })
        review.setMessage("")
        return result
      },
      toAppError,
    )
  const runPush = () =>
    runFlow(push, "pushing", () => api.push(props.placementId, { setUpstream: !status.data?.upstream }), toAppError)
  const commitLabel = () => {
    const state = commit.state()
    if (state.kind !== "running") return t("review.commit")
    return state.step === "staging" ? t("review.commit.staging") : t("review.commit.committing")
  }
  const pushLabel = () => {
    if (push.state().kind === "running") return t("review.push.pushing")
    if (!status.data?.upstream) return t("review.publish")
    return status.data.ahead > 0 ? `${t("review.push")} ${status.data.ahead}` : t("review.push")
  }
  return (
    <section
      aria-label={t("review.commit")}
      data-testid="review-commit"
      class="flex shrink-0 flex-col gap-2 border-t border-border-muted px-3 py-2"
    >
      <Show when={changes().length > 0}>
        <FileChecklist changes={changes()} />
      </Show>
      <Textarea
        rows={2}
        value={review.message()}
        placeholder={t("review.commit.message")}
        aria-label={t("review.commit.messageLabel")}
        onInput={(event) => review.setMessage(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canCommit()) void runCommit()
        }}
      />
      <div class="flex flex-wrap gap-2">
        <Button size="normal" disabled={!canCommit()} onClick={() => void runCommit()}>
          {commitLabel()}
        </Button>
        <Button
          size="normal"
          variant="outline"
          disabled={push.state().kind === "running"}
          onClick={() => void runPush()}
        >
          {pushLabel()}
        </Button>
      </div>
      <FlowNotice commit={commit.state()} push={push.state()} />
    </section>
  )
}
