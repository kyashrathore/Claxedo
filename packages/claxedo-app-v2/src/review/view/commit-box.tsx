import { createMemo, For, Show, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import type { FileChange, GitStatus, PlacementId } from "@/server"
import { fetchView } from "@/files"
import { useReviewApi } from "../api"
import { t } from "../i18n"
import { createFlow, errorText, runFlow, type CommitFlow, type PushFlow } from "../model"
import { useReview } from "../store"

function changedPaths(status: GitStatus | undefined): readonly FileChange[] {
  if (!status) return []
  const seen = new Set<string>()
  return [...status.staged, ...status.unstaged].filter((change) => {
    if (seen.has(change.path)) return false
    seen.add(change.path)
    return true
  })
}

function commitLabel(flow: CommitFlow): string {
  if (flow.kind === "running") return flow.step === "staging" ? t("review.commit.staging") : t("review.commit.committing")
  return t("review.commit")
}

function pushLabel(flow: PushFlow, status: GitStatus | undefined): string {
  if (flow.kind === "running") return t("review.push.pushing")
  if (!status?.upstream) return t("review.publish")
  return status.ahead > 0 ? `${t("review.push")} ${status.ahead}` : t("review.push")
}

export function CommitBox(props: { readonly placementId: PlacementId }): JSX.Element {
  const api = useReviewApi()
  const review = useReview()
  const query = useQuery(() => api.status(props.placementId))
  const status = createMemo(() => {
    const view = fetchView(query)
    return view.kind === "ready" ? view.data : undefined
  })
  const changes = createMemo(() => changedPaths(status()))
  const selected = () => changes().filter((change) => !review.excluded(change.path)).map((change) => change.path)
  const commit = createFlow<"staging" | "committing", { readonly hash: string }>()
  const push = createFlow<"pushing", { readonly remote: string; readonly branch: string }>()
  const canCommit = () => review.message().trim().length > 0 && selected().length > 0 && commit.state().kind !== "running"
  const runCommit = () =>
    runFlow(commit, "staging", async (step) => {
      const staged = new Set((status()?.staged ?? []).map((change) => change.path))
      const excluded = changes().map((change) => change.path).filter((path) => review.excluded(path) && staged.has(path))
      if (excluded.length > 0) await api.unstage(props.placementId, excluded)
      await api.stage(props.placementId, selected())
      step("committing")
      const result = await api.commit(props.placementId, { message: review.message().trim() })
      review.setMessage("")
      return result
    })
  const runPush = () => runFlow(push, "pushing", () => api.push(props.placementId, { setUpstream: !status()?.upstream }))
  return (
    <section data-component="review-commit" aria-label={t("review.commit")} class="flex flex-col gap-2 border-t border-border-weak-base px-3 py-2">
      <Show when={changes().length > 0}>
        <fieldset class="flex flex-col gap-0.5">
          <legend class="text-11-regular text-text-weak">{t("review.commit.files")}</legend>
          <For each={changes()}>
            {(change) => (
              <label class="flex min-h-7 items-center gap-2 text-12-regular text-text-base pointer-coarse:min-h-11">
                <input type="checkbox" checked={!review.excluded(change.path)} onChange={(event) => review.setExcluded(change.path, !event.currentTarget.checked)} />
                <span class="min-w-0 break-all">{change.path}</span>
              </label>
            )}
          </For>
        </fieldset>
      </Show>
      <textarea
        rows={2}
        value={review.message()}
        placeholder={t("review.commit.message")}
        aria-label={t("review.commit.message")}
        class="w-full resize-y rounded-md border border-border-weak-base bg-surface-base px-2 py-1.5 text-12-regular text-text-base outline-none placeholder:text-text-weak focus:border-border-strong-base"
        onInput={(event) => review.setMessage(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canCommit()) void runCommit()
        }}
      />
      <div class="flex flex-wrap gap-2">
        <button type="button" disabled={!canCommit()} class="min-h-8 rounded-md bg-surface-base-active px-3 text-12-medium text-text-base disabled:opacity-50 pointer-coarse:min-h-11" onClick={() => void runCommit()}>
          {commitLabel(commit.state())}
        </button>
        <button type="button" disabled={push.state().kind === "running"} class="min-h-8 rounded-md border border-border-weak-base px-3 text-12-medium text-text-base disabled:opacity-50 pointer-coarse:min-h-11" onClick={() => void runPush()}>
          {pushLabel(push.state(), status())}
        </button>
      </div>
      <FlowNotice commit={commit.state()} push={push.state()} />
    </section>
  )
}

function FlowNotice(props: { readonly commit: CommitFlow; readonly push: PushFlow }) {
  return (
    <div role="status" class="flex flex-col gap-1 text-11-regular">
      <Show when={props.commit.kind === "done" && props.commit}>
        {(done) => <span class="text-text-weak">{t("review.commit.done", { hash: done().kind === "done" ? done().result.hash.slice(0, 7) : "" })}</span>}
      </Show>
      <Show when={props.commit.kind === "failed" && props.commit}>
        {(failed) => <span role="alert" class="text-icon-critical-base">{failed().kind === "failed" ? errorText(failed().error) : ""}</span>}
      </Show>
      <Show when={props.push.kind === "done" && props.push}>
        {(done) => <span class="text-text-weak">{done().kind === "done" ? t("review.push.done", { remote: done().result.remote, branch: done().result.branch }) : ""}</span>}
      </Show>
      <Show when={props.push.kind === "failed" && props.push}>
        {(failed) => <span role="alert" class="text-icon-critical-base">{failed().kind === "failed" ? errorText(failed().error) : ""}</span>}
      </Show>
    </div>
  )
}
