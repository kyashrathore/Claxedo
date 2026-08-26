import type { VcsFileDiff } from "@opencode-ai/sdk/v2"
import type { VcsRefs } from "./review-toolbar"
import { queryClient } from "@/platform/query/query-client"

// The review VCS modules read the diff contract through this module so the
// SDK import surface stays in one place.
export type { VcsFileDiff } from "@opencode-ai/sdk/v2"

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
  return ["shell", "review-vcs-diff", input.directory, input.mode, input.fromRef ?? "", input.toRef ?? ""] as const
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

export function cachedReviewVcsDiff(
  input: ReviewVcsDiffInput & {
    force?: boolean
    load: () => Promise<VcsFileDiff[]>
  },
) {
  const queryKey = reviewVcsDiffQueryKey(input)
  if (input.force) queryClient.removeQueries({ queryKey, exact: true })
  return queryClient.fetchQuery({
    queryKey,
    queryFn: input.load,
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export async function cachedReviewVcsFile(
  input: ReviewVcsFileInput & {
    force?: boolean
    load: () => Promise<ReviewVcsFileDiff | undefined>
  },
) {
  const queryKey = reviewVcsFileQueryKey(input)
  if (input.force) queryClient.removeQueries({ queryKey, exact: true })
  const result = await queryClient.fetchQuery({
    queryKey,
    queryFn: async () => (await input.load()) ?? null,
    staleTime: Number.POSITIVE_INFINITY,
  })
  return result ?? undefined
}

export function cachedReviewVcsRefs(
  input: ReviewVcsDirectory & {
    force?: boolean
    load: () => Promise<VcsRefs>
  },
) {
  const queryKey = reviewVcsRefsQueryKey(input)
  if (input.force) queryClient.removeQueries({ queryKey, exact: true })
  return queryClient.fetchQuery({
    queryKey,
    queryFn: input.load,
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function cachedReviewVcsTargets(
  input: ReviewVcsDirectory & {
    force?: boolean
    load: () => Promise<ReviewVcsTargets>
  },
) {
  const queryKey = reviewVcsTargetsQueryKey(input)
  if (input.force) queryClient.removeQueries({ queryKey, exact: true })
  return queryClient.fetchQuery({
    queryKey,
    queryFn: input.load,
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function updateCachedReviewVcsDiff(
  input: ReviewVcsDiffInput & {
    file: string
    update: (diff: VcsFileDiff) => VcsFileDiff
  },
) {
  queryClient.setQueryData<VcsFileDiff[]>(reviewVcsDiffQueryKey(input), (diffs) => {
    if (!diffs) return diffs
    return diffs.map((diff) => (diff.file === input.file ? input.update(diff) : diff))
  })
}

const REVIEW_VCS_QUERY_KINDS = ["review-vcs-diff", "review-vcs-file", "review-vcs-refs", "review-vcs-targets"] as const

function isReviewVcsQueryKey(queryKey: readonly unknown[]) {
  const kind = queryKey[1]
  return queryKey[0] === "shell" && REVIEW_VCS_QUERY_KINDS.some((name) => name === kind)
}

/**
 * Drop every cached review read for one workspace directory.
 *
 * The query cache is module-scoped, so this works while no Review surface is
 * mounted: a review whose DOM was disposed when the change landed still
 * refetches on its next mount instead of restoring stale diffs.
 */
export function invalidateReviewVcsDirectory(input: ReviewVcsDirectory) {
  queryClient.removeQueries({
    predicate: (query) => isReviewVcsQueryKey(query.queryKey) && query.queryKey[2] === input.directory,
  })
}

export function resetReviewVcsCacheForTest() {
  queryClient.removeQueries({ predicate: (query) => isReviewVcsQueryKey(query.queryKey) })
}
