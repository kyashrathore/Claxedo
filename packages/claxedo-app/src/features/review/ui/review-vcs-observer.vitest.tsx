/**
 * The changed-file set reaches a surface that is already on screen.
 *
 * A review holding its own copy of the corpus could not be reached by the
 * directory invalidation `WorkspaceVcsCacheHonesty` fires, so a change landing
 * while the review was mounted left it rendering the set it loaded first --
 * nothing at all, when the review opened on a clean worktree.
 */
import { render, waitFor } from "@solidjs/testing-library"
import { QueryClientProvider, useQuery } from "@tanstack/solid-query"
import { afterEach, describe, expect, test, vi } from "vitest"

import { queryClient } from "@/platform/query/query-client"
import { invalidateReviewVcsDirectory, reviewVcsDiffQueryKey } from "./review-vcs-cache"
import { reviewVcsDiffSummaryQueryOptions } from "./review-vcs-load"

type DiffRow = { file: string; additions: number; deletions: number; status?: string }

const target = { directory: "/repo", mode: "uncommitted" }
const queryKey = reviewVcsDiffQueryKey(target)

afterEach(() => {
  queryClient.clear()
  vi.restoreAllMocks()
})

function renderCorpus(vcs: () => Promise<DiffRow[]>) {
  const view = render(() => (
    <QueryClientProvider client={queryClient}>
      {(() => {
        const query = useQuery(() => reviewVcsDiffSummaryQueryOptions({ client: { vcs }, ...target }))
        return <div data-testid="corpus">{(query.data ?? []).map((diff) => diff.file).join(",")}</div>
      })()}
    </QueryClientProvider>
  ))
  return {
    corpus: () => view.getByTestId("corpus").textContent,
    // An empty corpus renders exactly like one that has not loaded, so the
    // query's own state is what says the first read landed.
    settled: () => waitFor(() => expect(queryClient.getQueryState(queryKey)?.status).toBe("success")),
  }
}

describe("review diff corpus", () => {
  test("a mounted surface refetches when the worktree invalidation fires", async () => {
    let worktree: DiffRow[] = []
    const vcs = vi.fn(async () => worktree)

    const view = renderCorpus(vcs)
    await view.settled()
    expect(view.corpus()).toBe("")
    expect(vcs).toHaveBeenCalledTimes(1)

    worktree = [{ file: "src/app.ts", additions: 3, deletions: 1, status: "M" }]
    invalidateReviewVcsDirectory({ directory: "/repo" })

    await waitFor(() => expect(view.corpus()).toBe("src/app.ts"))
    expect(vcs).toHaveBeenCalledTimes(2)
  })

  test("another worktree's invalidation leaves this corpus alone", async () => {
    const vcs = vi.fn(async () => [{ file: "src/app.ts", additions: 1, deletions: 0 }])

    const view = renderCorpus(vcs)
    await view.settled()
    expect(view.corpus()).toBe("src/app.ts")

    invalidateReviewVcsDirectory({ directory: "/other" })

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(vcs).toHaveBeenCalledTimes(1)
  })
})
