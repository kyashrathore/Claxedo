import { render } from "@solidjs/testing-library"
import { describe, expect, test } from "vitest"
import { TitlebarDragRegion } from "./titlebar-drag-region"

describe("TitlebarDragRegion", () => {
  test("is an OS drag surface kept out of the accessibility tree", () => {
    const view = render(() => <TitlebarDragRegion class="w-4" />)

    const region = view.getByTestId("titlebar-drag-region")
    expect(region.hasAttribute("data-window-drag-region")).toBe(true)
    expect(region.getAttribute("aria-hidden")).toBe("true")
    expect(region.className).toContain("w-4")
  })
})
