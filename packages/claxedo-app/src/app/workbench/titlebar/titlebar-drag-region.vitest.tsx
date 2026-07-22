import { render } from "@solidjs/testing-library"
import { describe, expect, test } from "vitest"
import { TitlebarDragRegion } from "./titlebar-drag-region"

describe("TitlebarDragRegion", () => {
  test("is an OS drag surface kept out of the accessibility tree", () => {
    const { getByTestId } = render(() => <TitlebarDragRegion class="w-4" />)

    const region = getByTestId("titlebar-drag-region")
    expect(region.hasAttribute("data-window-drag-region")).toBe(true)
    expect(region.getAttribute("aria-hidden")).toBe("true")
    expect(region.className).toContain("w-4")
  })
})
