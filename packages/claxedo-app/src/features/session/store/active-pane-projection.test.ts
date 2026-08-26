import { createEffect, createSignal, flush } from "solid-js"
import { expect, test } from "bun:test"
import { mountReactive } from "@/lib/test-support/reactive-root"
import { createActivePaneProjection } from "./active-pane-projection"

test("hidden source updates cause no pane work and activation catches up once", () => {
  const [active, setActive] = createSignal(true)
  const [source, setSource] = createSignal("initial")
  let sourceReads = 0
  let consumerRuns = 0

  const [projected, dispose] = mountReactive(() => {
    const projected = createActivePaneProjection({
      active,
      initial: "",
      read: () => {
        sourceReads += 1
        return source()
      },
    })
    createEffect(
      () => {
        projected()
        consumerRuns += 1
      },
      () => {},
    )
    return projected
  })

  try {
    expect(projected()).toBe("initial")
    expect(sourceReads).toBe(1)
    expect(consumerRuns).toBe(1)

    setActive(false)
    setSource("hidden one")
    setSource("hidden two")
    // Flush before asserting: the claim is not "the writes have not landed yet",
    // it is that a SETTLED system with a hidden pane did no pane work at all.
    flush()

    expect(projected()).toBe("initial")
    expect(sourceReads).toBe(1)
    expect(consumerRuns).toBe(1)

    setActive(true)
    flush()

    expect(projected()).toBe("hidden two")
    expect(sourceReads).toBe(2)
    expect(consumerRuns).toBe(2)
  } finally {
    dispose()
  }
})

test("an activation-owned publication performs zero hidden writes and one catch-up write", () => {
  const [active, setActive] = createSignal(true)
  const [title, setTitle] = createSignal("Initial")
  const writes: string[] = []

  const [, dispose] = mountReactive(() => {
    const projectedTitle = createActivePaneProjection({ active, read: title, initial: "" })
    createEffect(
      () => {
        if (!active()) return
        writes.push(projectedTitle())
      },
      () => {},
    )
  })

  try {
    expect(writes).toEqual(["Initial"])

    setActive(false)
    setTitle("Hidden one")
    setTitle("Hidden two")
    flush()
    expect(writes).toEqual(["Initial"])

    setActive(true)
    flush()
    expect(writes).toEqual(["Initial", "Hidden two"])
  } finally {
    dispose()
  }
})
