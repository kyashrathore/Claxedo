// Does the extension-view host follow the view registry the way
// ContentRenderer follows the surface registry? A pane restored from persisted
// state exists BEFORE its extension's idle-time activation registers the view,
// so the host must resolve live: fallback first, then the mounted view the
// moment registration lands — and the extension's dispose must run when the
// pane unmounts.

import { describe, expect, test, afterEach, vi } from "vitest"
import { render, screen } from "@solidjs/testing-library"
import { ExtensionViewContent } from "./extension-view-content"
import {
  registerUserExtensionView,
  removeUserExtensionViews,
} from "@/platform/extensions/user-extension-views"
import type { ContentMeta } from "../state/index"

const meta: ContentMeta = {
  id: "ext_1",
  type: "extension-view",
  viewId: "hello-clock.clock",
  directory: "/tmp/project",
}

afterEach(() => {
  removeUserExtensionViews("hello-clock")
})

describe("ExtensionViewContent", () => {
  test("mounts a registered view into a live container and disposes on unmount", () => {
    const dispose = vi.fn()
    const mount = vi.fn((container: HTMLElement) => {
      container.textContent = "tick"
      return dispose
    })
    registerUserExtensionView({
      id: "hello-clock.clock",
      title: "Clock",
      extension: { name: "hello-clock", version: "1.0.0" },
      mount,
    })

    const { unmount } = render(() => <ExtensionViewContent meta={meta} />)

    expect(mount).toHaveBeenCalledTimes(1)
    expect(mount.mock.calls[0]![1]).toEqual({ directory: "/tmp/project" })
    const container = document.querySelector("[data-user-extension-view='hello-clock.clock']")
    expect(container?.textContent).toBe("tick")
    expect(dispose).not.toHaveBeenCalled()

    unmount()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  test("shows the fallback before the extension loads, then mounts once it registers", async () => {
    const { unmount } = render(() => <ExtensionViewContent meta={meta} />)

    expect(screen.getByTestId("extension-view-missing")).toBeTruthy()

    registerUserExtensionView({
      id: "hello-clock.clock",
      title: "Clock",
      extension: { name: "hello-clock", version: "1.0.0" },
      mount: (container) => {
        container.textContent = "late but live"
      },
    })
    await Promise.resolve()

    expect(screen.queryByTestId("extension-view-missing")).toBeNull()
    expect(document.querySelector("[data-user-extension-view='hello-clock.clock']")?.textContent).toBe("late but live")
    unmount()
  })

  test("a throwing mount degrades to an empty container instead of breaking the pane", () => {
    registerUserExtensionView({
      id: "hello-clock.clock",
      title: "Clock",
      extension: { name: "hello-clock", version: "1.0.0" },
      mount: () => {
        throw new Error("mount boom")
      },
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    const { unmount } = render(() => <ExtensionViewContent meta={meta} />)

    expect(document.querySelector("[data-user-extension-view='hello-clock.clock']")).toBeTruthy()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("failed to mount"))
    warn.mockRestore()
    unmount()
  })
})
