import { describe, expect, mock, test } from "bun:test"
import { createDaemonExitLifecycle } from "./daemon-exit-lifecycle"

describe("desktop daemon exit lifecycle", () => {
  test("a normal app quit releases its lease without fencing running work", async () => {
    const stop = mock(async () => {})
    const drain = mock(async () => {})

    const lease = { stop, drain }
    await createDaemonExitLifecycle().release(lease)

    expect(stop).toHaveBeenCalledTimes(1)
    expect(drain).not.toHaveBeenCalled()
  })

  test("an exit before lease acquisition is safe", async () => {
    await expect(createDaemonExitLifecycle().release(undefined)).resolves.toBeUndefined()
  })
})
