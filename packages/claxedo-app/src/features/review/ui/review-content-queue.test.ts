import { describe, expect, test } from "bun:test"
import { createReviewContentQueue, type ReviewContentRequest } from "./review-content-queue"

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function content(key: string, starts: string[]) {
  const gate = Promise.withResolvers<void>()
  const request: ReviewContentRequest = { key, load: () => { starts.push(key); return gate.promise } }
  return { request, ...gate }
}

describe("review content scheduling", () => {
  test("bounds in-flight fetches and prioritizes the latest visible range on reversal", async () => {
    const starts: string[] = []
    const jobs = ["a", "b", "old-ahead", "new-visible", "new-ahead"].map((key) => content(key, starts))
    const queue = createReviewContentQueue({ concurrency: 2, onError: () => { throw new Error("Unexpected failure") } })
    queue.replace(jobs.slice(0, 3).map((job) => job.request))
    await tick()
    expect(starts).toEqual(["a", "b"])
    queue.replace([jobs[3].request, jobs[4].request, jobs[0].request])
    jobs[0].resolve()
    await tick()
    expect(starts).toEqual(["a", "b", "new-visible"])
    jobs[1].resolve()
    await tick()
    expect(starts).toEqual(["a", "b", "new-visible", "new-ahead"])
    queue.dispose()
    for (const job of jobs) job.resolve()
  })

  test("coalesces a range before starting and dedupes an in-flight file", async () => {
    const starts: string[] = []
    const old = content("old", starts)
    const current = content("current", starts)
    const queue = createReviewContentQueue({ onError: () => {} })
    queue.replace([old.request])
    queue.replace([current.request, current.request])
    await tick()
    queue.replace([current.request])
    await tick()
    expect(starts).toEqual(["current"])
    current.resolve()
    await tick()
    expect(starts).toEqual(["current"])
    queue.dispose()
  })

  test("a failed fetch releases its slot, reports the error, and can be retried explicitly", async () => {
    const starts: string[] = []
    const failure = new Error("offline")
    const errors: unknown[] = []
    const first = content("first", starts)
    const next = content("next", starts)
    const queue = createReviewContentQueue({ concurrency: 1, onError: (_, error) => errors.push(error) })
    queue.replace([first.request, next.request])
    await tick()
    first.reject(failure)
    await tick()
    expect(errors).toEqual([failure])
    expect(starts).toEqual(["first", "next"])
    const retry = content("first", starts)
    queue.replace([retry.request])
    next.resolve()
    await tick()
    expect(starts).toEqual(["first", "next", "first"])
    retry.resolve()
    queue.dispose()
  })

  test("disposal drops queued work and ignores late errors without starting new requests", async () => {
    const starts: string[] = []
    const errors: unknown[] = []
    const first = content("first", starts)
    const queued = content("queued", starts)
    const queue = createReviewContentQueue({ concurrency: 1, onError: (_, error) => errors.push(error) })
    queue.replace([first.request, queued.request])
    await tick()
    queue.dispose()
    first.reject(new Error("late failure"))
    queue.replace([queued.request])
    await tick()
    expect(starts).toEqual(["first"])
    expect(errors).toEqual([])
  })

  test("disposal between scheduling and dispatch does not start the fetch", async () => {
    const starts: string[] = []
    const job = content("file", starts)
    const queue = createReviewContentQueue({ onError: () => {} })
    queue.replace([job.request])
    queueMicrotask(() => queue.dispose())
    await tick()
    expect(starts).toEqual([])
  })
})
