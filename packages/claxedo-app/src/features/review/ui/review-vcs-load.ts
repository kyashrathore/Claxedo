import { createWorkspaceDiffClient } from "@/platform/runtime/workspace-diff-client"
import { resolveWorkspaceRuntime } from "@/platform/runtime/workspace-runtime-record"
import {
  cachedReviewVcsDiff,
  reviewVcsDiffQueryOptions,
  type ReviewVcsDiffInput,
  type VcsFileDiff,
} from "./review-vcs-cache"

export type RawVcsFileDiff = Omit<VcsFileDiff, "status" | "patch"> & {
  before?: string
  after?: string
  patch?: string
  status?: string
}

export function normalizeVcsStatus(status: string | undefined): VcsFileDiff["status"] | undefined {
  if (status === "A" || status === "added") return "added"
  if (status === "D" || status === "deleted") return "deleted"
  if (!status) return undefined
  return "modified"
}

export function normalizeVcsDiff(diff: RawVcsFileDiff): VcsFileDiff {
  return { ...diff, status: normalizeVcsStatus(diff.status) } as VcsFileDiff
}

type DiffClientInput = Parameters<typeof createWorkspaceDiffClient>[0]

/** The review surfaces' diff client, with runtime resolution wired the one way. */
export function createReviewDiffClient(input: Omit<DiffClientInput, "resolveWorkspaceRuntime">) {
  return createWorkspaceDiffClient({
    ...input,
    resolveWorkspaceRuntime: (runtime) => resolveWorkspaceRuntime({
      baseUrl: input.serverUrl,
      request: input.request,
      directory: runtime.directory,
    }),
  })
}

/**
 * The summary read needs one method off the diff client. Naming just that
 * lets a caller — a test, a narrower surface — supply what it actually has.
 */
type ReviewVcsDiffSummaryInput = ReviewVcsDiffInput & {
  client: Pick<ReturnType<typeof createReviewDiffClient>, "vcs">
}

/**
 * Bypassing the cache is a fetch-only answer: the options path hands its loader
 * to an observer, which decides for itself when to run it.
 */
type ReviewVcsDiffSummaryFetchInput = ReviewVcsDiffSummaryInput & {
  force?: boolean
}

function reviewVcsDiffSummaryLoad(input: ReviewVcsDiffSummaryFetchInput) {
  const { client, directory, mode, fromRef, toRef, force } = input
  return () => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("claxedo:review-vcs-load", {
        detail: { directory, mode, from: fromRef, to: toRef, force: force === true },
      }))
    }
    return client
      .vcs({ directory, mode, fromRef, toRef, content: "summary" })
      .then((data) => data.map((diff) => normalizeVcsDiff(diff)))
  }
}

/**
 * The canonical changed-file summary read: one loader and one cache key for
 * every reader — the mounted Review surface, which observes these options, and
 * the panel-open prefetch, which fetches them — so a click-time warm-up and
 * the surface's own load always dedupe, and one invalidation reaches both.
 */
export function reviewVcsDiffSummaryQueryOptions(input: ReviewVcsDiffSummaryInput) {
  const { directory, mode, fromRef, toRef } = input
  return reviewVcsDiffQueryOptions({
    directory,
    mode,
    fromRef,
    toRef,
    load: reviewVcsDiffSummaryLoad(input),
  })
}

export function fetchReviewVcsDiffSummary(input: ReviewVcsDiffSummaryFetchInput) {
  const { directory, mode, fromRef, toRef, force } = input
  return cachedReviewVcsDiff({
    directory,
    mode,
    fromRef,
    toRef,
    force,
    load: reviewVcsDiffSummaryLoad(input),
  })
}
