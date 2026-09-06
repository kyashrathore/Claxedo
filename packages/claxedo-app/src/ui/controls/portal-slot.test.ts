import { describe, expect, test } from "bun:test"
import { createPortalSlot } from "@/ui/controls/portal-slot"

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

})
