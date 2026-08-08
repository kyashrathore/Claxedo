import { afterEach, describe, expect, test, vi } from "vitest"

import {
  acquireVirtualizer,
  virtualMetrics,
} from "../../../../../session-ui/src/pierre/virtualizer"

afterEach(() => {
  document.body.replaceChildren()
  virtualMetrics.lineHeight = 24
  vi.unstubAllGlobals()
})

describe("Pierre virtualizer cache", () => {
  test("does not share container-specific overscan across one scroll root", () => {
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    vi.stubGlobal("IntersectionObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    const root = document.createElement("div")
    root.style.overflowY = "auto"
    const content = document.createElement("div")
    content.setAttribute("role", "log")
    const regular = document.createElement("div")
    const inlineHost = document.createElement("div")
    inlineHost.dataset.component = "edit-content"
    const inline = document.createElement("div")
    inlineHost.append(inline)
    root.append(content, regular, inlineHost)
    document.body.append(root)
    virtualMetrics.lineHeight = undefined

    const regularLease = acquireVirtualizer(regular)!
    const inlineLease = acquireVirtualizer(inline)!

    expect(inlineLease.virtualizer).not.toBe(regularLease.virtualizer)
    expect((regularLease.virtualizer as unknown as { config?: { overscrollSize?: number } }).config?.overscrollSize).toBe(1000)
    expect((inlineLease.virtualizer as unknown as { config?: { overscrollSize?: number } }).config?.overscrollSize).toBe(240)
    regularLease.release()
    inlineLease.release()
  })
})
