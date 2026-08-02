import { cleanup, render } from "@solidjs/testing-library"
import { afterEach, describe, expect, test } from "vitest"
import { TitlebarEditIcon } from "./v2-edit-icon"

afterEach(() => cleanup())

describe("TitlebarEditIcon", () => {
  test("renders the mapped Codex edit glyph", () => {
    const view = render(() => <TitlebarEditIcon />)
    const svg = view.container.querySelector("svg")
    const use = view.container.querySelector("use")

    expect(svg?.getAttribute("data-slot")).toBe("icon-svg")
    expect(svg?.getAttribute("viewBox")).toBe("0 0 20 20")
    expect(use?.getAttribute("href")).toMatch(/#codex-20-019$/)
  })
})
