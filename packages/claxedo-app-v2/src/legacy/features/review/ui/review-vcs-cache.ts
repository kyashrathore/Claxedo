import type { AgentVcsFileDiff as VcsFileDiff } from "@claxedo/agent-runtime-contract"
import type { VcsRefs } from "./review-toolbar"
import { queryClient } from "@/platform/query/query-client"

// The review VCS modules read the diff contract through this module so the
// SDK import surface stays in one place.
export type { AgentVcsFileDiff as VcsFileDiff } from "@claxedo/agent-runtime-contract"

/** One workspace worktree, as every review read and invalidation names it. */
export type ReviewVcsDirectory = {
  directory: string
}

export type ReviewVcsDiffInput = ReviewVcsDirectory & {
  mode: string
  fromRef?: string
  toRef?: string
}

type ReviewVcsFileInput = ReviewVcsDiffInput & {
  file: string
}

type ReviewVcsFileDiff = Partial<VcsFileDiff> & { file: string }

type ReviewVcsTargets = {
  defaultRef?: string
  candidates?: string[]
}

export function reviewVcsDiffQueryKey(input: ReviewVcsDiffInput) {
  return [
    "shell",
    "review-vcs-diff",
    input.directory,
    input.mode,
    input.fromRef ?? "",
    input.toRef ?? "",
  ] as const
}

export function reviewVcsFileQueryKey(input: ReviewVcsFileInput) {
  return [
    "shell",
    "review-vcs-file",
    input.directory,
    input.mode,
    input.fromRef ?? "",
    input.toRef ?? "",
    input.file,
  ] as const
}

export function reviewVcsRefsQueryKey(input: ReviewVcsDirectory) {
  return ["shell", "review-vcs-refs", input.directory] as const
}

export function reviewVcsTargetsQueryKey(input: ReviewVcsDirectory) {
  return ["shell", "review-vcs-targets", input.directory] as const
}

/**
 * The cached changed-file list, if this review target has one — synchronous,
 * no fetch. A remounted review seeds its first render from this so restoring
 * a disposed panel paints the corpus immediately instead of showing an empty
 * pane until the deferred load runs.
 */
export function peekReviewVcsDiff(input: ReviewVcsDiffInput) {
  return queryClient.getQueryData<VcsFileDiff[]>(reviewVcsDiffQueryKey(input))
}

/**
 * The changed-file list for one review target, as query options.
 *
 * Both readers build from this: the mounted surface observes it through
 * `useQuery`, and the panel-open prefetch fetches it. One key, one loader, one
 * `staleTime`, so an observer and a prefetch of the same target dedupe and an
 * invalidation reaches both.
 */
export function reviewVcsDiffQueryOptions(input: ReviewVcsDiffInput & {
  load: () => Promise<VcsFileDiff[]>
}) {
  return {
    queryKey: reviewVcsDiffQueryKey(input),
    queryFn: input.load,
    staleTime: Number.POSITIVE_INFINITY,
  }
}

export function cachedReviewVcsDiff(input: ReviewVcsDiffInput & {
  force?: boolean
  load: () => Promise<VcsFileDiff[]>
}) {
  const options = reviewVcsDiffQueryOptions(input)
  if (input.force) queryClient.removeQueries({ queryKey: options.queryKey, exact: true })
  return queryClient.fetchQuery(options)
}

export async function cachedReviewVcsFile(input: ReviewVcsFileInput & {
  force?: boolean
  load: () => Promise<ReviewVcsFileDiff | undefined>
}) {
  const queryKey = reviewVcsFileQueryKey(input)
  if (input.force) queryClient.removeQueries({ queryKey, exact: true })
  const result = await queryClient.fetchQuery({
    queryKey,
    queryFn: async () => await input.load() ?? null,
    staleTime: Number.POSITIVE_INFINITY,
  })
  return result ?? undefined
}

export function cachedReviewVcsRefs(input: ReviewVcsDirectory & {
  force?: boolean
  load: () => Promise<VcsRefs>
}) {
  const queryKey = reviewVcsRefsQueryKey(input)
  if (input.force) queryClient.removeQueries({ queryKey, exact: true })
  return queryClient.fetchQuery({
    queryKey,
    queryFn: input.load,
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function cachedReviewVcsTargets(input: ReviewVcsDirectory & {
  force?: boolean
  load: () => Promise<ReviewVcsTargets>
}) {
  const queryKey = reviewVcsTargetsQueryKey(input)
  if (input.force) queryClient.removeQueries({ queryKey, exact: true })
  return queryClient.fetchQuery({
    queryKey,
    queryFn: input.load,
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function updateCachedReviewVcsDiff(input: ReviewVcsDiffInput & {
  file: string
  update: (diff: VcsFileDiff) => VcsFileDiff
}) {
  queryClient.setQueryData<VcsFileDiff[]>(reviewVcsDiffQueryKey(input), (diffs) => {
    if (!diffs) return diffs
    return diffs.map((diff) => diff.file === input.file ? input.update(diff) : diff)
  })
}

const REVIEW_VCS_QUERY_KINDS = [
  "review-vcs-diff",
  "review-vcs-file",
  "review-vcs-refs",
  "review-vcs-targets",
] as const

function isReviewVcsQueryKey(queryKey: readonly unknown[]) {
  const kind = queryKey[1]
  return queryKey[0] === "shell" && REVIEW_VCS_QUERY_KINDS.some((name) => name === kind)
}

/**
 * Mark every cached review read for one workspace directory out of date.
 *
 * Invalidation rather than removal, because the mounted Review surface
 * observes these entries: an observer refetches in place on invalidation,
 * where a removal would have left it rendering the copy it already held. The
 * one-shot readers (a file's content, refs, targets) refetch too — a stale
 * entry does not satisfy `fetchQuery`.
 *
 * The query cache is module-scoped, so this works while no Review surface is
 * mounted: a review whose DOM was disposed when the change landed refetches on
 * its next mount instead of restoring stale diffs.
 */
export function invalidateReviewVcsDirectory(input: ReviewVcsDirectory) {
  void queryClient.invalidateQueries({
    predicate: (query) => isReviewVcsQueryKey(query.queryKey) && query.queryKey[2] === input.directory,
  })
}

export function resetReviewVcsCacheForTest() {
  queryClient.removeQueries({ predicate: (query) => isReviewVcsQueryKey(query.queryKey) })
}
