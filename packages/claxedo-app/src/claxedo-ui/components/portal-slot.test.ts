import { describe, expect, test } from "bun:test"
import { createRoot, onCleanup } from "solid-js"
import { createPortalSlot } from "./portal-slot"

// createPortalSlot() is the single factory backing every DOM "portal slot"
// in the app (browser toolbar, review toolbar, review tab header, titlebar
// left/center/right). These tests pin its set/clear/single-binding contract
// so an agent could rebuild every one of those six slot pairs from this
// file alone.

describe("createPortalSlot", () => {
  test("accessor returns null before any element is set", () => {
    const [slot] = createPortalSlot("test-slot")
    expect(slot()).toBeNull()
  })

  test("set(el) makes the accessor return that exact element", () => {
    const [slot, setSlot] = createPortalSlot("test-slot")
    const el = document.createElement("div")
    setSlot(el)
    expect(slot()).toBe(el)
  })

  test("set(null) clears a previously set element back to null", () => {
    const [slot, setSlot] = createPortalSlot("test-slot")
    const el = document.createElement("div")
    setSlot(el)
    setSlot(null)
    expect(slot()).toBeNull()
  })

  test("single-binding: setting a second element replaces the first rather than accumulating", () => {
    const [slot, setSlot] = createPortalSlot("test-slot")
    const first = document.createElement("div")
    const second = document.createElement("span")
    setSlot(first)
    setSlot(second)
    expect(slot()).toBe(second)
    expect(slot()).not.toBe(first)
  })

  test("two independent createPortalSlot() calls never share state", () => {
    const [slotA, setSlotA] = createPortalSlot("slot-a")
    const [slotB] = createPortalSlot("slot-b")
    const el = document.createElement("div")
    setSlotA(el)
    expect(slotA()).toBe(el)
    expect(slotB()).toBeNull()
  })

  // Solid's `ref={(el) => ...}` callback is a plain function call — Solid
  // invokes it and discards whatever it returns. A consumer that wants to
  // clear a slot when its owning element unmounts MUST register that
  // teardown with `onCleanup()` from inside the callback; returning a
  // cleanup closure (a common React-ref habit) is silently a no-op. These
  // two tests pin that contrast so a regression to the return-based pattern
  // (as happened in components/titlebar/titlebar.tsx) is caught here rather than by
  // observing a stale slot in the app.
  test("onCleanup registered inside a ref callback clears the slot when the owning root disposes", () => {
    const [slot, setSlot] = createPortalSlot("test-slot")
    const el = document.createElement("div")

    // Mirrors the fixed titlebar.tsx pattern:
    // ref={(el) => { setSlot(el); onCleanup(() => setSlot(null)) }}
    let dispose = () => {}
    createRoot((d) => {
      dispose = d
      setSlot(el)
      onCleanup(() => setSlot(null))
    })

    expect(slot()).toBe(el)
    dispose()
    expect(slot()).toBeNull()
  })

  test("a cleanup closure returned from a ref callback is never invoked by Solid, so the slot stays set after the owning root disposes", () => {
    const [slot, setSlot] = createPortalSlot("test-slot")
    const el = document.createElement("div")

    // Mirrors the pre-fix titlebar.tsx bug:
    // ref={(el) => { setSlot(el); return () => setSlot(null) }}
    const refCallback = (element: HTMLElement | null) => {
      setSlot(element)
      return () => setSlot(null)
    }

    let dispose = () => {}
    createRoot((d) => {
      dispose = d
      refCallback(el) // Solid calls exactly this, discarding the return value.
    })

    expect(slot()).toBe(el)
    dispose()
    expect(slot()).toBe(el)
  })
})
