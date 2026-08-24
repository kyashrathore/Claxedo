import { describe, expect, test } from "bun:test"
import { createRoot, flush, onCleanup, runWithOwner } from "solid-js"
import { createPortalSlot, createPortalSlotRef } from "@/ui/controls/portal-slot"

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
    flush()
    expect(slot()).toBe(el)
  })

  test("set(null) clears a previously set element back to null", () => {
    const [slot, setSlot] = createPortalSlot("test-slot")
    const el = document.createElement("div")
    setSlot(el)
    setSlot(null)
    flush()
    expect(slot()).toBeNull()
  })

  test("single-binding: setting a second element replaces the first rather than accumulating", () => {
    const [slot, setSlot] = createPortalSlot("test-slot")
    const first = document.createElement("div")
    const second = document.createElement("span")
    setSlot(first)
    setSlot(second)
    flush()
    expect(slot()).toBe(second)
    expect(slot()).not.toBe(first)
  })

  test("two independent createPortalSlot() calls never share state", () => {
    const [slotA, setSlotA] = createPortalSlot("slot-a")
    const [slotB] = createPortalSlot("slot-b")
    const el = document.createElement("div")
    setSlotA(el)
    flush()
    expect(slotA()).toBe(el)
    expect(slotB()).toBeNull()
  })

  // Solid 2 invokes ref callbacks without an owner and ignores their return
  // values. Lifecycle setup must therefore happen in the owned directive
  // factory, before its returned element callback runs.
  test("the owned ref factory clears the slot when its root disposes", () => {
    const [slot, setSlot] = createPortalSlot("test-slot")
    const el = document.createElement("div")

    let dispose = () => {}
    createRoot((d) => {
      dispose = d
      const ref = createPortalSlotRef(setSlot)
      runWithOwner(null, () => ref(el))
    })

    flush()
    expect(slot()).toBe(el)
    dispose()
    flush()
    expect(slot()).toBeNull()
  })

  test("onCleanup inside an unowned ref callback is not registered", () => {
    const [slot, setSlot] = createPortalSlot("test-slot")
    const el = document.createElement("div")

    const refCallback = (element: HTMLElement | null) => {
      setSlot(element)
      onCleanup(() => setSlot(null))
    }

    let dispose = () => {}
    createRoot((d) => {
      dispose = d
      runWithOwner(null, () => refCallback(el))
    })

    flush()
    expect(slot()).toBe(el)
    dispose()
    flush()
    expect(slot()).toBe(el)
  })
})
