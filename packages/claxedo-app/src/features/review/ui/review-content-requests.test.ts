import { describe, expect, test } from "bun:test"
import { createReviewContentQueue } from "./review-content-queue"
import { reviewContentRequestPlan, reviewMediaLoad } from "./review-content-requests"

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const corpus = {
  "src/app.ts": { status: "modified" as const },
  "docs/logo.png": { status: "modified" as const },
  "docs/gone.png": { status: "deleted" as const },
  "icons/mark.svg": { status: "modified" as const },
}
type Path = keyof typeof corpus

function plan(overrides: {
  files: Path[]
  hasDiff?: (file: string) => boolean
  hasMedia?: (file: string) => boolean
  hasError?: (file: string) => boolean
}) {
  return reviewContentRequestPlan({
    files: overrides.files,
    isMedia: (file) => file.endsWith(".png") || file.endsWith(".mp3"),
    isDeleted: (file) => corpus[file as Path]?.status === "deleted",
    isKnown: (file) => file in corpus,
    hasDiff: overrides.hasDiff ?? (() => false),
    hasMedia: overrides.hasMedia ?? (() => false),
    hasError: overrides.hasError ?? (() => false),
  })
}

describe("what a rendered range still owes", () => {
  test("a media row asks for its bytes and never for a text diff", () => {
    expect(plan({ files: ["docs/logo.png", "src/app.ts"] })).toEqual([
      { file: "docs/logo.png", kind: "media" },
      { file: "src/app.ts", kind: "diff" },
    ])
  })

  test("an SVG is a diff, because its row renders the text diff", () => {
    expect(plan({ files: ["icons/mark.svg"] })).toEqual([{ file: "icons/mark.svg", kind: "diff" }])
  })

  test("a deleted media file is never read", () => {
    expect(plan({ files: ["docs/gone.png"] })).toEqual([])
  })

  test("content already in a cache is not asked for again", () => {
    expect(plan({ files: ["docs/logo.png"], hasMedia: (file) => file === "docs/logo.png" })).toEqual([])
    expect(plan({ files: ["src/app.ts"], hasDiff: (file) => file === "src/app.ts" })).toEqual([])
  })

  test("a failed row waits for the reader's retry instead of looping", () => {
    expect(plan({ files: ["docs/logo.png", "src/app.ts"], hasError: () => true })).toEqual([])
  })

  test("the caller's visible-first order survives, without duplicates", () => {
    expect(plan({ files: ["src/app.ts", "docs/logo.png", "src/app.ts"] })).toEqual([
      { file: "src/app.ts", kind: "diff" },
      { file: "docs/logo.png", kind: "media" },
    ])
  })
})

/**
 * The provider records a failed read and resolves; it does not reject. These
 * exercise the load callbacks the review builds on top of that contract.
 */
function fileProvider() {
  const content = new Map<string, string>()
  const errors = new Map<string, string>()
  const calls: Array<{ path: string; force: boolean }> = []
  let answer: (path: string) => { ok: true; bytes: string } | { ok: false; error: string } = (path) => ({ ok: true, bytes: `bytes:${path}` })
  return {
    calls,
    set answerWith(next: typeof answer) { answer = next },
    load: async (path: string, options?: { force?: boolean }) => {
      calls.push({ path, force: options?.force === true })
      const result = answer(path)
      if (result.ok) {
        content.set(path, result.bytes)
        errors.delete(path)
        return
      }
      errors.set(path, result.error)
    },
    get: (path: string) => ({ content: content.get(path), error: errors.get(path) }),
  }
}


describe("a media row's load through the review queue", () => {
  test("a failed read reaches the queue's error channel instead of pending forever", async () => {
    const provider = fileProvider()
    provider.answerWith = () => ({ ok: false, error: "file is unreadable" })
    const failures: Array<{ key: string; message: string }> = []
    const queue = createReviewContentQueue({
      onError: (request, error) => failures.push({ key: request.key, message: (error as Error).message }),
    })
    const retries = new Set<string>()
    queue.replace([{
      key: "k:logo",
      load: reviewMediaLoad({ reader: provider, path: "docs/logo.png", key: "k:logo", targetKey: "t1", currentTargetKey: () => "t1", retries }),
    }])
    await tick()

    expect(failures).toEqual([{ key: "k:logo", message: "file is unreadable" }])
    queue.dispose()
  })

  test("the reader's retry forces a fresh read and clears the row", async () => {
    const provider = fileProvider()
    provider.answerWith = () => ({ ok: false, error: "file is unreadable" })
    const failures: string[] = []
    const queue = createReviewContentQueue({ onError: (request) => failures.push(request.key) })
    const retries = new Set<string>()
    const request = {
      key: "k:logo",
      load: reviewMediaLoad({ reader: provider, path: "docs/logo.png", key: "k:logo", targetKey: "t1", currentTargetKey: () => "t1", retries }),
    }
    queue.replace([request])
    await tick()
    expect(failures).toEqual(["k:logo"])
    expect(provider.calls).toEqual([{ path: "docs/logo.png", force: false }])

    // Retry: the reader clears the error and marks the key, the range effect
    // queues it again, and this time the read is forced past the cached failure.
    provider.answerWith = (path) => ({ ok: true, bytes: `bytes:${path}` })
    retries.add("k:logo")
    queue.replace([request])
    await tick()

    expect(provider.calls).toEqual([
      { path: "docs/logo.png", force: false },
      { path: "docs/logo.png", force: true },
    ])
    expect(failures).toEqual(["k:logo"])
    expect(provider.get("docs/logo.png").content).toBe("bytes:docs/logo.png")
    queue.dispose()
  })

  test("a request queued for one target does not read after the target changed", async () => {
    const provider = fileProvider()
    let currentTarget = "t1"
    const failures: string[] = []
    const queue = createReviewContentQueue({ onError: (request) => failures.push(request.key) })
    queue.replace([{
      key: "k:logo",
      load: reviewMediaLoad({
        reader: provider,
        path: "docs/logo.png",
        key: "k:logo",
        targetKey: "t1",
        currentTargetKey: () => currentTarget,
        retries: new Set<string>(),
      }),
    }])
    currentTarget = "t2"
    await tick()

    expect(provider.calls).toEqual([])
    expect(failures).toEqual([])
    queue.dispose()
  })

  test("a row that leaves the rendered range drops its unstarted read", async () => {
    const provider = fileProvider()
    const queue = createReviewContentQueue({ onError: () => undefined })
    const request = {
      key: "k:logo",
      load: reviewMediaLoad({
        reader: provider,
        path: "docs/logo.png",
        key: "k:logo",
        targetKey: "t1",
        currentTargetKey: () => "t1",
        retries: new Set<string>(),
      }),
    }
    queue.replace([request])
    queue.replace([])
    await tick()

    expect(provider.calls).toEqual([])
    queue.dispose()
  })

  test("disposing the review drops queued reads", async () => {
    const provider = fileProvider()
    const queue = createReviewContentQueue({ onError: () => undefined })
    queue.replace([{
      key: "k:logo",
      load: reviewMediaLoad({
        reader: provider,
        path: "docs/logo.png",
        key: "k:logo",
        targetKey: "t1",
        currentTargetKey: () => "t1",
        retries: new Set<string>(),
      }),
    }])
    queue.dispose()
    await tick()

    expect(provider.calls).toEqual([])
  })
})
