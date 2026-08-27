import { describe, expect, test } from "bun:test"
import { scheduleTimelineFirstFoldReveal } from "./timeline-first-fold-reveal"

describe("scheduleTimelineFirstFoldReveal", () => {
  test("uses exactly one pre-paint task to prepare and reveal the synchronously mounted first fold", () => {
    const tasks: Array<() => void> = []
    const events: string[] = []
    scheduleTimelineFirstFoldReveal({
      activationKey: "ses_a:1",
      currentActivationKey: () => "ses_a:1",
      prepare: () => events.push("prepare"),
      reveal: () => events.push("reveal"),
      scheduleTask: (callback) => tasks.push(callback),
    })

    expect(tasks).toHaveLength(1)
    expect(events).toEqual([])
    tasks[0]!()
    expect(events).toEqual(["prepare", "reveal"])
    expect(tasks).toHaveLength(1)
  })

  test("a stale retained-session task neither anchors nor reveals", () => {
    let task: (() => void) | undefined
    let current = "ses_a:1"
    const events: string[] = []
    scheduleTimelineFirstFoldReveal({
      activationKey: current,
      currentActivationKey: () => current,
      prepare: () => events.push("prepare"),
      reveal: () => events.push("reveal"),
      scheduleTask: (callback) => {
        task = callback
      },
    })

    current = "ses_b:1"
    task?.()
    expect(events).toEqual([])
  })

  test("a cancelled retained-session task neither anchors nor reveals", () => {
    let task: (() => void) | undefined
    const events: string[] = []
    const cancel = scheduleTimelineFirstFoldReveal({
      activationKey: "ses_a:1",
      currentActivationKey: () => "ses_a:1",
      prepare: () => events.push("prepare"),
      reveal: () => events.push("reveal"),
      scheduleTask: (callback) => {
        task = callback
      },
    })

    cancel()
    task?.()
    expect(events).toEqual([])
  })
})
