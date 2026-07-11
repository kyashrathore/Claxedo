import { cleanup, render } from "@solidjs/testing-library"
import { afterEach, describe, expect, test } from "vitest"
import { TitlebarEditIcon } from "./v2-edit-icon"

afterEach(() => cleanup())

describe("TitlebarEditIcon", () => {
  test("renders the preserved Claxedo edit glyph", () => {
    const view = render(() => <TitlebarEditIcon />)
    const svg = view.container.querySelector("svg")
    const path = view.container.querySelector("path")

    expect(svg?.getAttribute("data-slot")).toBe("icon-svg")
    expect(svg?.getAttribute("viewBox")).toBe("0 0 20 20")
    expect(path?.getAttribute("fill")).toBe("currentColor")
  })
})
