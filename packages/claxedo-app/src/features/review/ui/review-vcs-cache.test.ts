import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import type { VcsFileDiff } from "@opencode-ai/sdk/v2"
import { queryClient } from "@/platform/query/query-client"
import {
  cachedReviewVcsDiff,
  cachedReviewVcsFile,
  cachedReviewVcsRefs,
  cachedReviewVcsTargets,
  resetReviewVcsCacheForTest,
  reviewVcsDiffQueryKey,
  reviewVcsFileQueryKey,
  updateCachedReviewVcsDiff,
} from "./review-vcs-cache"

const root = path.resolve(import.meta.dir, "../../..")

describe("review VCS cache", () => {
  afterEach(() => {
    resetReviewVcsCacheForTest()
  })

  test("dedupes and caches summary diff requests through Query", async () => {
    let calls = 0
    const load = async () => {
      calls++
      return [{ file: "README.md", additions: 1, deletions: 0, status: "added" }] as VcsFileDiff[]
    }

    const first = cachedReviewVcsDiff({ directory: "/repo", mode: "uncommitted", load })
    const second = cachedReviewVcsDiff({ directory: "/repo", mode: "uncommitted", load })

    expect(await first).toEqual(await second)
    expect(calls).toBe(1)
    expect(await cachedReviewVcsDiff({ directory: "/repo", mode: "uncommitted", load })).toHaveLength(1)
    expect(calls).toBe(1)
    expect(queryClient.getQueryData(reviewVcsDiffQueryKey({ directory: "/repo", mode: "uncommitted" }))).toHaveLength(1)
  })

  test("force reloads a cached summary diff", async () => {
    let calls = 0
    const load = async () => {
      calls++
      return [{ file: `file-${calls}.ts`, additions: calls, deletions: 0, status: "modified" }] as VcsFileDiff[]
    }

    expect((await cachedReviewVcsDiff({ directory: "/repo", mode: "uncommitted", load }))[0]?.file).toBe("file-1.ts")
    expect((await cachedReviewVcsDiff({ directory: "/repo", mode: "uncommitted", force: true, load }))[0]?.file).toBe(
      "file-2.ts",
    )
    expect(calls).toBe(2)
  })

  test("caches missing file content without refetching immediately", async () => {
    let calls = 0
    const load = async () => {
      calls++
      return undefined
    }

    expect(
      await cachedReviewVcsFile({ directory: "/repo", mode: "uncommitted", file: "README.md", load }),
    ).toBeUndefined()
    expect(
      await cachedReviewVcsFile({ directory: "/repo", mode: "uncommitted", file: "README.md", load }),
    ).toBeUndefined()

    expect(calls).toBe(1)
    expect(
      queryClient.getQueryData(
        reviewVcsFileQueryKey({
          directory: "/repo",
          mode: "uncommitted",
          file: "README.md",
        }),
      ),
    ).toBeNull()
  })

  test("dedupes review refs and target requests through Query", async () => {
    let refs = 0
    let targets = 0

    expect(
      await cachedReviewVcsRefs({
        directory: "/repo",
        load: async () => {
          refs++
          return { branches: ["main"], tags: [], recent: [] }
        },
      }),
    ).toEqual({ branches: ["main"], tags: [], recent: [] })
    expect(
      await cachedReviewVcsRefs({
        directory: "/repo",
        load: async () => {
          refs++
          return { branches: ["dev"], tags: [], recent: [] }
        },
      }),
    ).toEqual({ branches: ["main"], tags: [], recent: [] })
    expect(
      await cachedReviewVcsTargets({
        directory: "/repo",
        load: async () => {
          targets++
          return { defaultRef: "origin/dev", candidates: ["origin/dev"] }
        },
      }),
    ).toEqual({ defaultRef: "origin/dev", candidates: ["origin/dev"] })
    expect(
      await cachedReviewVcsTargets({
        directory: "/repo",
        load: async () => {
          targets++
          return { defaultRef: "origin/main", candidates: ["origin/main"] }
        },
      }),
    ).toEqual({ defaultRef: "origin/dev", candidates: ["origin/dev"] })

    expect(refs).toBe(1)
    expect(targets).toBe(1)
  })

  test("updates cached summary rows after file content loads", async () => {
    await cachedReviewVcsDiff({
      directory: "/repo",
      mode: "to-from",
      fromRef: "origin/main",
      toRef: "HEAD",
      load: async () =>
        [
          { file: "README.md", additions: 1, deletions: 0, status: "modified" },
          { file: "src/app.ts", additions: 2, deletions: 1, status: "modified" },
        ] as VcsFileDiff[],
    })

    updateCachedReviewVcsDiff({
      directory: "/repo",
      mode: "to-from",
      fromRef: "origin/main",
      toRef: "HEAD",
      file: "src/app.ts",
      update: (diff) => ({ ...diff, patch: "diff --git a/src/app.ts b/src/app.ts" }),
    })

    expect(
      queryClient.getQueryData<VcsFileDiff[]>(
        reviewVcsDiffQueryKey({
          directory: "/repo",
          mode: "to-from",
          fromRef: "origin/main",
          toRef: "HEAD",
        }),
      )?.[1]?.patch,
    ).toBe("diff --git a/src/app.ts b/src/app.ts")
  })

  test("ReviewTab does not own VCS payloads in private maps", async () => {
    const text = await Bun.file(path.join(root, "features/review/ui/review-tab.tsx")).text()

    expect(text).toMatch(/cachedReviewVcsDiff/)
    expect(text).toMatch(/cachedReviewVcsFile/)
    expect(text).toMatch(/cachedReviewVcsRefs/)
    expect(text).toMatch(/cachedReviewVcsTargets/)
    expect(text).toMatch(/initialReviewOpenDiffs\(files/)
    expect(text).not.toMatch(/setStore\("openDiffs", files\)/)
    expect(text).not.toMatch(/vcsDiffCache = new Map/)
    expect(text).not.toMatch(/vcsDiffInflight = new Map/)
    expect(text).not.toMatch(/vcsFileCache = new Map/)
    expect(text).not.toMatch(/vcsFileInflight = new Map/)
  })
})
