import { createComputed, createRoot, createSignal } from "solid-js"
import { expect, test } from "bun:test"
import { createActivePaneProjection } from "./active-pane-projection"

test("hidden source updates cause no pane work and activation catches up once", () => {
  createRoot((dispose) => {
    const [active, setActive] = createSignal(true)
    const [source, setSource] = createSignal("initial")
    let sourceReads = 0
    const projected = createActivePaneProjection({
      active,
      initial: "",
      read: () => {
        sourceReads += 1
        return source()
      },
    })
    let consumerRuns = 0

    createComputed(() => {
      projected()
      consumerRuns += 1
    })

    expect(projected()).toBe("initial")
    expect(sourceReads).toBe(1)
    expect(consumerRuns).toBe(1)

    setActive(false)
    setSource("hidden one")
    setSource("hidden two")

    expect(projected()).toBe("initial")
    expect(sourceReads).toBe(1)
    expect(consumerRuns).toBe(1)

    setActive(true)

    expect(projected()).toBe("hidden two")
    expect(sourceReads).toBe(2)
    expect(consumerRuns).toBe(2)
    dispose()
  })
})

test("an activation-owned publication performs zero hidden writes and one catch-up write", () => {
  createRoot((dispose) => {
    const [active, setActive] = createSignal(true)
    const [title, setTitle] = createSignal("Initial")
    const projectedTitle = createActivePaneProjection({ active, read: title, initial: "" })
    const writes: string[] = []

    createComputed(() => {
      if (!active()) return
      writes.push(projectedTitle())
    })

    expect(writes).toEqual(["Initial"])
    setActive(false)
    setTitle("Hidden one")
    setTitle("Hidden two")
    expect(writes).toEqual(["Initial"])

    setActive(true)
    expect(writes).toEqual(["Initial", "Hidden two"])
    dispose()
  })
})
