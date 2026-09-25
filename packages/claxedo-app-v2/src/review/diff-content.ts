import { createMemo, type Accessor } from "solid-js"
import { useQueries } from "@tanstack/solid-query"
import { isMediaPath } from "@/files"
import {
  useServer,
  type AppError,
  type DiffFile,
  type DiffScope,
  type DiffSummary,
  type FileContent,
  type PlacementId,
} from "@/server"
import type { ReviewCodeViewDiff } from "@/transcript"
import { useReviewApi } from "./api"
import { createRequestedFiles } from "./requested-files"

export const MAX_DIFF_CHANGED_LINES = 500

export type RowBody = {
  readonly media: boolean
  readonly guarded: boolean
  readonly deleted: boolean
  readonly content: FileContent | undefined
  readonly changedLines: number
  readonly error: AppError | undefined
  readonly retry: () => void
}

export type DiffContent = {
  readonly diffs: Accessor<readonly ReviewCodeViewDiff[]>
  readonly custom: Accessor<ReadonlySet<string>>
  readonly body: (file: string) => RowBody
  readonly request: (files: readonly string[]) => void
}

export type DiffContentInput = {
  readonly placementId: PlacementId
  readonly scope: Accessor<DiffScope>
  readonly summaries: Accessor<readonly DiffSummary[]>
  readonly forced: (file: string) => boolean
}

type QueryResult<T> = {
  readonly status: "pending" | "error" | "success"
  readonly data: T | undefined
  readonly error: AppError | null
  readonly refetch: () => unknown
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

function indexedResult<T>(files: Accessor<readonly string[]>, results: readonly QueryResult<T>[]) {
  return (file: string) => {
    const index = files().indexOf(file)
    return index === -1 ? undefined : results[index]
  }
}

function createRowQueries(
  input: DiffContentInput,
  known: Accessor<readonly DiffSummary[]>,
  guarded: (summary: DiffSummary) => boolean,
) {
  const api = useReviewApi()
  const server = useServer()
  const texts = createMemo(() =>
    known().flatMap((summary) => (isMediaPath(summary.file) || guarded(summary) ? [] : [summary.file])),
  )
  const media = createMemo(() =>
    known().flatMap((summary) => (isMediaPath(summary.file) && summary.status !== "deleted" ? [summary.file] : [])),
  )
  const textResults = useQueries(() => ({
    queries: texts().map((file) => api.diffFile(input.placementId, input.scope(), file)),
  }))
  const mediaResults = useQueries(() => ({
    queries: media().map((file) => server.queries.files.content(input.placementId, file)),
  }))
  return { textOf: indexedResult(texts, textResults), mediaOf: indexedResult(media, mediaResults) }
}

export function createDiffContent(input: DiffContentInput): DiffContent {
  const requested = createRequestedFiles(() => JSON.stringify(input.scope()))
  const summaryOf = (file: string) => input.summaries().find((summary) => summary.file === file)
  const guarded = (summary: DiffSummary) =>
    !isMediaPath(summary.file) && changedLines(summary) > MAX_DIFF_CHANGED_LINES && !input.forced(summary.file)
  const known = createMemo(() => requested.files().flatMap((file) => summaryOf(file) ?? []))
  const { textOf, mediaOf } = createRowQueries(input, known, guarded)
  const body = (file: string): RowBody => {
    const summary = summaryOf(file)
    const media = mediaOf(file)
    const result = isMediaPath(file) ? media : textOf(file)
    return {
      media: isMediaPath(file),
      guarded: summary !== undefined && guarded(summary),
      deleted: summary?.status === "deleted",
      content: media?.data,
      changedLines: summary ? changedLines(summary) : 0,
      error: result?.status === "error" ? (result.error ?? undefined) : undefined,
      retry: () => void result?.refetch(),
    }
  }
  const ready = (file: string) => !isMediaPath(file) && textOf(file)?.status === "success"
  return {
    diffs: createMemo(() => input.summaries().map((summary) => withContent(summary, textOf(summary.file)?.data))),
    custom: createMemo(
      () => new Set(input.summaries().flatMap((summary) => (ready(summary.file) ? [] : [summary.file]))),
    ),
    body,
    request: requested.request,
  }
}
