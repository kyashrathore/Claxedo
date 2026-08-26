import { createEffect, createRoot, createSignal, flush } from "solid-js"
import { expect, test } from "vitest"
import { createActiveLocationSnapshot } from "./active-location-snapshot"

test("hidden retained surfaces unsubscribe from global location changes and catch up on activation", () => {
  const counts = { runs: 0, pathnameReads: 0 }
  const [active, setActive] = createSignal(true)
  const [pathname, setPathname] = createSignal("/w/one/session/a")
  const [search, setSearch] = createSignal("")
  const [hash, setHash] = createSignal("")

  // The root only CONSTRUCTS the snapshot and its observer: Solid 2 rejects a
  // signal write from inside an owned scope, and the router writes these from
  // outside the graph anyway. Every write below is staged until `flush()`.
  const { location, dispose } = createRoot((dispose) => {
    const location = createActiveLocationSnapshot({
      active,
      pathname: () => {
        counts.pathnameReads += 1
        return pathname()
      },
      search,
      hash,
    })

    // `createComputed` is gone in Solid 2; a two-phase effect whose compute
    // reads the snapshot is the equivalent observer. The compute runs
    // synchronously at creation, so `runs` is 1 here exactly as before.
    createEffect(
      () => {
        location()
        counts.runs += 1
      },
      () => {},
    )

    return { location, dispose }
  })

  try {
    expect(counts.runs).toBe(1)
    expect(counts.pathnameReads).toBe(2)

    setActive(false)
    flush()
    // Going inactive republishes the retained snapshot by identity, so the
    // memo's value is unchanged and the observer does not re-run.
    expect(counts.runs).toBe(1)
    expect(counts.pathnameReads).toBe(2)

    setPathname("/w/two/session/b")
    setSearch("?prompt=next")
    setHash("#message-2")
    flush()
    expect(counts.runs).toBe(1)
    expect(counts.pathnameReads).toBe(2)
    expect(location()).toEqual({ pathname: "/w/one/session/a", search: "", hash: "" })

    setActive(true)
    flush()
    expect(counts.runs).toBe(2)
    expect(counts.pathnameReads).toBe(3)
    expect(location()).toEqual({
      pathname: "/w/two/session/b",
      search: "?prompt=next",
      hash: "#message-2",
    })
  } finally {
    dispose()
  }
})
