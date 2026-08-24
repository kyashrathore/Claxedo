import type { VcsFileDiff } from "@opencode-ai/sdk/v2"
import type { VcsRefs } from "./review-toolbar"
import { queryClient } from "@/platform/query/query-client"

type ReviewVcsDiffInput = {
  directory: string
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

export function reviewVcsRefsQueryKey(input: { directory: string }) {
  return ["shell", "review-vcs-refs", input.directory] as const
}

export function reviewVcsTargetsQueryKey(input: { directory: string }) {
  return ["shell", "review-vcs-targets", input.directory] as const
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

export function cachedReviewVcsRefs(input: { directory: string; force?: boolean; load: () => Promise<VcsRefs> }) {
  const queryKey = reviewVcsRefsQueryKey(input)
  if (input.force) queryClient.removeQueries({ queryKey, exact: true })
  return queryClient.fetchQuery({
    queryKey,
    queryFn: input.load,
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function cachedReviewVcsTargets(input: {
  directory: string
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

export function resetReviewVcsCacheForTest() {
  queryClient.removeQueries({
    predicate: (query) =>
      query.queryKey[0] === "shell" &&
      (query.queryKey[1] === "review-vcs-diff" ||
        query.queryKey[1] === "review-vcs-file" ||
        query.queryKey[1] === "review-vcs-refs" ||
        query.queryKey[1] === "review-vcs-targets"),
  })
}
