import { describe, expect, mock, test } from "bun:test"
import { createDaemonExitLifecycle } from "./daemon-exit-lifecycle"

describe("desktop daemon exit lifecycle", () => {
  test("a normal app quit requests graceful daemon shutdown", async () => {
    const stop = mock(async () => {})
    const shutdown = mock(async () => {})

    await createDaemonExitLifecycle().release({ stop, shutdown })

    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(stop).not.toHaveBeenCalled()
  })

  test("an app restart or update only releases its lease for handoff", async () => {
    const stop = mock(async () => {})
    const shutdown = mock(async () => {})
    const lifecycle = createDaemonExitLifecycle()

    lifecycle.handoff()
    await lifecycle.release({ stop, shutdown })

    expect(stop).toHaveBeenCalledTimes(1)
    expect(shutdown).not.toHaveBeenCalled()
  })
})
