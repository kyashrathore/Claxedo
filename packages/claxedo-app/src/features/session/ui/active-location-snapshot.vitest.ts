import { createComputed, createRoot, createSignal } from "solid-js"
import { expect, test } from "vitest"
import { createActiveLocationSnapshot } from "./active-location-snapshot"

test("hidden retained surfaces unsubscribe from global location changes and catch up on activation", () => {
  createRoot((dispose) => {
    const [active, setActive] = createSignal(true)
    const [pathname, setPathname] = createSignal("/w/one/session/a")
    const [search, setSearch] = createSignal("")
    const [hash, setHash] = createSignal("")
    let pathnameReads = 0
    const location = createActiveLocationSnapshot({
      active,
      pathname: () => {
        pathnameReads += 1
        return pathname()
      },
      search,
      hash,
    })
    let runs = 0

    createComputed(() => {
      location()
      runs += 1
    })

    expect(runs).toBe(1)
    expect(pathnameReads).toBe(2)
    setActive(false)
    expect(runs).toBe(1)

    setPathname("/w/two/session/b")
    setSearch("?prompt=next")
    setHash("#message-2")
    expect(runs).toBe(1)
    expect(pathnameReads).toBe(2)
    expect(location()).toEqual({ pathname: "/w/one/session/a", search: "", hash: "" })

    setActive(true)
    expect(runs).toBe(2)
    expect(pathnameReads).toBe(3)
    expect(location()).toEqual({
      pathname: "/w/two/session/b",
      search: "?prompt=next",
      hash: "#message-2",
    })
    dispose()
  })
})
