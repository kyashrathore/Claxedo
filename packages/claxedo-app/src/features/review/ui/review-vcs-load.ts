import { createWorkspaceDiffClient } from "@/platform/runtime/workspace-diff-client"
import { resolveWorkspaceRuntime } from "@/platform/runtime/workspace-runtime-record"
import { cachedReviewVcsDiff, type ReviewVcsDiffInput, type VcsFileDiff } from "./review-vcs-cache"

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
 * The canonical changed-file summary fetch: one loader and one cache key for
 * every reader — the mounted Review surface and the panel-open prefetch — so
 * a click-time warm-up and the surface's own load always dedupe.
 */
export function fetchReviewVcsDiffSummary(input: ReviewVcsDiffInput & {
  client: ReturnType<typeof createReviewDiffClient>
  force?: boolean
}) {
  const { client, directory, mode, fromRef, toRef, force } = input
  return cachedReviewVcsDiff({
    directory,
    mode,
    fromRef,
    toRef,
    force,
    load: () => {
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("claxedo:review-vcs-load", {
          detail: { directory, mode, from: fromRef, to: toRef, force: force === true },
        }))
      }
      return client
        .vcs({ directory, mode, fromRef, toRef, content: "summary" })
        .then((data) => data.map((diff) => normalizeVcsDiff(diff)))
    },
  })
}
