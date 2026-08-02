import { expect, test, vi } from "vitest"
import { skipOverlappingReconcile } from "./reconcile-serialize"

test("overlapping reconcile triggers skip instead of running concurrently", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let running = 0
  let maxRunning = 0
  const inner = vi.fn(async () => {
    running += 1
    maxRunning = Math.max(maxRunning, running)
    await gate
    running -= 1
    return { launched: ["a"], results: [] }
  })
  const reconcile = skipOverlappingReconcile(inner)

  const first = reconcile()
  const second = reconcile()
  await expect(second).resolves.toEqual({ launched: [], results: [], skipped: true })
  expect(inner).toHaveBeenCalledTimes(1)

  release()
  await expect(first).resolves.toEqual({ launched: ["a"], results: [] })
  expect(maxRunning).toBe(1)

  await expect(reconcile()).resolves.toEqual({ launched: ["a"], results: [] })
  expect(inner).toHaveBeenCalledTimes(2)
})

test("a failed run releases the guard for the next trigger", async () => {
  const inner = vi.fn()
    .mockRejectedValueOnce(new Error("reconcile blew up"))
    .mockResolvedValueOnce({ launched: [], results: [] })
  const reconcile = skipOverlappingReconcile(inner)

  await expect(reconcile()).rejects.toThrow("reconcile blew up")
  await expect(reconcile()).resolves.toEqual({ launched: [], results: [] })
})
