import { createMemo, createSignal, type Accessor } from "solid-js"
import { useQueries } from "@tanstack/solid-query"
import { isMediaPath } from "@/files"
import type { AppError, DiffFile, DiffScope, DiffSummary, PlacementId } from "@/server"
import type { ReviewCodeViewDiff } from "@/transcript"
import { useReviewApi } from "./api"

export const MAX_DIFF_CHANGED_LINES = 500
const MAX_REQUESTED_FILES = 64

export type DiffBody =
  | { readonly kind: "media" }
  | { readonly kind: "large"; readonly changedLines: number }
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly error: AppError; readonly retry: () => void }
  | { readonly kind: "ready" }

export type DiffContent = {
  readonly diffs: Accessor<readonly ReviewCodeViewDiff[]>
  readonly custom: Accessor<ReadonlySet<string>>
  readonly body: (file: string) => DiffBody
  readonly request: (files: readonly string[]) => void
}

export type DiffContentInput = {
  readonly placementId: PlacementId
  readonly scope: Accessor<DiffScope>
  readonly summaries: Accessor<readonly DiffSummary[]>
  readonly forced: (file: string) => boolean
}

const changedLines = (summary: DiffSummary) => summary.additions + summary.deletions

function withContent(summary: DiffSummary, content: DiffFile | undefined): ReviewCodeViewDiff {
  return {
    file: summary.file,
    additions: summary.additions,
    deletions: summary.deletions,
    ...(summary.status === undefined ? {} : { status: summary.status }),
    ...(content?.patch === undefined ? {} : { patch: content.patch }),
    ...(content?.before === undefined ? {} : { before: content.before }),
    ...(content?.after === undefined ? {} : { after: content.after }),
  }
}

function guardOf(summary: DiffSummary, forced: (file: string) => boolean): DiffBody | undefined {
  if (isMediaPath(summary.file)) return { kind: "media" }
  const lines = changedLines(summary)
  if (lines > MAX_DIFF_CHANGED_LINES && !forced(summary.file)) return { kind: "large", changedLines: lines }
  return undefined
}

function createRequestedFiles(scopeKey: Accessor<string>) {
  const [requested, setRequested] = createSignal<{ readonly key: string; readonly files: readonly string[] }>({
    key: "",
    files: [],
  })
  const files = () => (requested().key === scopeKey() ? requested().files : [])
  const request = (next: readonly string[]) => {
    const merged = [...new Set([...next, ...files()])].slice(0, MAX_REQUESTED_FILES)
    setRequested({ key: scopeKey(), files: merged })
  }
  return { files, request }
}

export function createDiffContent(input: DiffContentInput): DiffContent {
  const api = useReviewApi()
  const requested = createRequestedFiles(() => JSON.stringify(input.scope()))
  const summaryOf = (file: string) => input.summaries().find((summary) => summary.file === file)
  const guard = (file: string) => {
    const summary = summaryOf(file)
    return summary ? guardOf(summary, input.forced) : undefined
  }
  const fetched = createMemo(() =>
    requested.files().filter((file) => summaryOf(file) !== undefined && guard(file) === undefined),
  )
  const results = useQueries(() => ({
    queries: fetched().map((file) => api.diffFile(input.placementId, input.scope(), file)),
  }))
  const resultOf = (file: string) => {
    const index = fetched().indexOf(file)
    return index === -1 ? undefined : results[index]
  }
  const body = (file: string): DiffBody => {
    const guarded = guard(file)
    if (guarded) return guarded
    const result = resultOf(file)
    if (result?.status === "success") return { kind: "ready" }
    if (result?.status === "error") return { kind: "failed", error: result.error, retry: () => void result.refetch() }
    return { kind: "loading" }
  }
  return {
    diffs: createMemo(() => input.summaries().map((summary) => withContent(summary, resultOf(summary.file)?.data))),
    custom: createMemo(
      () =>
        new Set(input.summaries().flatMap((summary) => (body(summary.file).kind === "ready" ? [] : [summary.file]))),
    ),
    body,
    request: requested.request,
  }
}
