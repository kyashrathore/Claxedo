import { describe, expect, mock, test } from "bun:test"
import { createDaemonExitLifecycle } from "./daemon-exit-lifecycle"

describe("desktop daemon exit lifecycle", () => {
  test("a normal app quit drains the daemon it was holding", async () => {
    const stop = mock(async () => {})
    const drain = mock(async () => {})

    await createDaemonExitLifecycle().release({ stop, drain })

    expect(drain).toHaveBeenCalledTimes(1)
    expect(stop).not.toHaveBeenCalled()
  })

  test("an app restart or update only releases its lease for handoff", async () => {
    const stop = mock(async () => {})
    const drain = mock(async () => {})
    const lifecycle = createDaemonExitLifecycle()

    lifecycle.handoff()
    await lifecycle.release({ stop, drain })

    expect(stop).toHaveBeenCalledTimes(1)
    expect(drain).not.toHaveBeenCalled()
  })
})
