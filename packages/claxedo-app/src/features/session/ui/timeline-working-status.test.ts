import { createRoot, createSignal } from "solid-js"
import { expect, test } from "bun:test"
import { createTimelineWorkingStatus } from "./timeline-working-status"

test("a hidden pane neither starts nor completes working-indicator timers", () => {
  createRoot((dispose) => {
    const [active, setActive] = createSignal(true)
    const [working, setWorking] = createSignal(false)
    const pending: Array<{ task: () => void; cancelled: boolean }> = []
    const status = createTimelineWorkingStatus({
      active,
      working,
      schedule: (task) => {
        const timer = { task, cancelled: false }
        pending.push(timer)
        return () => {
          timer.cancelled = true
        }
      },
    })

    expect(status()).toBe("hidden")
    setWorking(true)
    expect(status()).toBe("showing")
    setActive(false)
    setWorking(false)
    expect(status()).toBe("showing")
    expect(pending).toHaveLength(0)

    setActive(true)
    expect(status()).toBe("hiding")
    expect(pending).toHaveLength(1)

    pending[0].task()
    expect(status()).toBe("hidden")
    dispose()
  })
})

test("hiding cancels an already armed pane timer and rearms once on activation", () => {
  createRoot((dispose) => {
    const [active, setActive] = createSignal(true)
    const [working, setWorking] = createSignal(true)
    const pending: Array<{ task: () => void; cancelled: boolean }> = []
    const status = createTimelineWorkingStatus({
      active,
      working,
      schedule: (task) => {
        const timer = { task, cancelled: false }
        pending.push(timer)
        return () => {
          timer.cancelled = true
        }
      },
    })

    expect(status()).toBe("showing")
    setWorking(false)
    expect(status()).toBe("hiding")
    expect(pending).toHaveLength(1)

    setActive(false)
    expect(pending[0].cancelled).toBe(true)
    setWorking(true)
    setWorking(false)
    expect(pending).toHaveLength(1)

    setActive(true)
    expect(pending).toHaveLength(2)
    pending[1].task()
    expect(status()).toBe("hidden")
    dispose()
  })
})
