import { describe, expect, test } from "bun:test"
import { createDisplayedFrameLoop } from "./timeline-displayed-frames"

function frames() {
  let token = 0
  const pending = new Map<number, () => void>()
  return {
    pending,
    scheduleFrame(callback: () => void) {
      const id = ++token
      pending.set(id, callback)
      return id
    },
    cancelFrame(id: number) {
      pending.delete(id)
    },
    /** Run every frame that is currently armed, once. Returns how many ran. */
    flush() {
      const armed = [...pending.values()]
      pending.clear()
      for (const callback of armed) callback()
      return armed.length
    },
  }
}

describe("createDisplayedFrameLoop", () => {
  test("a displayed surface keeps running its loop frame after frame", () => {
    const clock = frames()
    const loop = createDisplayedFrameLoop({ ...clock, displayed: () => true })
    let ran = 0
    loop.start(() => {
      ran += 1
      return ran < 5
    })
    for (let index = 0; index < 10 && loop.running; index++) clock.flush()
    expect(ran).toBe(5)
    expect(loop.running).toBe(false)
    expect(clock.pending.size).toBe(0)
  })

  test("stashing the surface parks the loop: it stops spending frames", () => {
    const clock = frames()
    let displayed = true
    const loop = createDisplayedFrameLoop({ ...clock, displayed: () => displayed })
    let ran = 0
    loop.start(() => {
      ran += 1
      return true
    })
    clock.flush()
    expect(ran).toBe(1)

    displayed = false
    // The frame already armed when the surface was stashed runs once more, but
    // refuses to execute the step and does not re-arm.
    clock.flush()
    expect(ran).toBe(1)
    expect(clock.pending.size).toBe(0)
    // Nothing is armed, so a display-locked surface cannot burn further frames.
    expect(clock.flush()).toBe(0)
    expect(ran).toBe(1)
    // The work is only PARKED — dropping it would restore the surface wrong.
    expect(loop.running).toBe(true)
  })

  test("re-displaying the surface resumes the same step where it parked", () => {
    const clock = frames()
    let displayed = true
    const loop = createDisplayedFrameLoop({ ...clock, displayed: () => displayed })
    let ran = 0
    loop.start(() => {
      ran += 1
      return ran < 3
    })
    clock.flush()
    displayed = false
    clock.flush()
    clock.flush()
    expect(ran).toBe(1)

    displayed = true
    loop.resume()
    expect(clock.pending.size).toBe(1)
    clock.flush()
    clock.flush()
    expect(ran).toBe(3)
    expect(loop.running).toBe(false)
  })

  test("a loop started while stashed arms nothing until the surface is displayed", () => {
    const clock = frames()
    let displayed = false
    const loop = createDisplayedFrameLoop({ ...clock, displayed: () => displayed })
    let ran = 0
    loop.start(() => {
      ran += 1
      return true
    })
    expect(clock.pending.size).toBe(0)
    expect(ran).toBe(0)

    displayed = true
    loop.resume()
    clock.flush()
    expect(ran).toBe(1)
  })

  test("resume on a displayed loop that is already armed does not double-arm", () => {
    const clock = frames()
    const loop = createDisplayedFrameLoop({ ...clock, displayed: () => true })
    loop.start(() => true)
    loop.resume()
    loop.resume()
    expect(clock.pending.size).toBe(1)
  })

  test("stop drops the work, so a later resume does not revive it", () => {
    const clock = frames()
    let displayed = true
    const loop = createDisplayedFrameLoop({ ...clock, displayed: () => displayed })
    let ran = 0
    loop.start(() => {
      ran += 1
      return true
    })
    loop.stop()
    expect(loop.running).toBe(false)
    displayed = false
    displayed = true
    loop.resume()
    expect(clock.pending.size).toBe(0)
    expect(clock.flush()).toBe(0)
    expect(ran).toBe(0)
  })

  test("starting a new loop replaces the previous one rather than racing it", () => {
    const clock = frames()
    const loop = createDisplayedFrameLoop({ ...clock, displayed: () => true })
    let first = 0
    let second = 0
    loop.start(() => {
      first += 1
      return true
    })
    loop.start(() => {
      second += 1
      return true
    })
    expect(clock.pending.size).toBe(1)
    clock.flush()
    expect(first).toBe(0)
    expect(second).toBe(1)
  })

  test("a step that finishes while displayed leaves nothing armed", () => {
    const clock = frames()
    const loop = createDisplayedFrameLoop({ ...clock, displayed: () => true })
    loop.start(() => false)
    clock.flush()
    expect(loop.running).toBe(false)
    expect(loop.scheduled).toBe(false)
  })
})
