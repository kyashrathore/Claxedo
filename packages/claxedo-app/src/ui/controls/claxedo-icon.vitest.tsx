import { cleanup, render } from "@solidjs/testing-library"
import { afterEach, describe, expect, test } from "vitest"
import { ClaxedoIcon } from "@/ui/controls/claxedo-icon"
import { ClaxedoIconButton } from "@/ui/controls/claxedo-icon-button"

describe("ClaxedoIcon", () => {
  afterEach(() => cleanup())

  test("refreshes a stale shared sprite before rendering worktree icons", () => {
    const sprite = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    sprite.id = "claxedo-icon-sprite"
    sprite.innerHTML = '<symbol id="claxedo-icon-worktree"><path data-stale="true" /></symbol>'
    document.body.prepend(sprite)

    render(() => <ClaxedoIcon name="worktree" />)

    expect(sprite.querySelector("[data-stale]")).toBeNull()
    expect(sprite.querySelector("#claxedo-icon-worktree path")?.getAttribute("d")).toContain("M4 10H8")
    expect(sprite.querySelector("#claxedo-icon-worktree path")?.getAttribute("stroke-width")).toBe("1.5")
  })

  test("renders Claxedo-owned glyphs from the app sprite", () => {
    const names = [
      "play",
      "worktree",
      "file-tree",
      "file-tree-active",
      "new-session",
      "file-text",
      "pin",
      "kebab",
      "more-horizontal",
      "globe",
      "cloud",
      "laptop",
      "reload",
      "page",
    ] as const

    const view = render(() => (
      <>
        {names.map((name) => <ClaxedoIcon name={name} />)}
      </>
    ))

    for (const name of names) {
      expect(view.container.querySelector(`use[href="#claxedo-icon-${name}"]`)).toBeTruthy()
    }
  })

  test("delegates normal upstream glyphs", () => {
    const view = render(() => <ClaxedoIcon name="plus" />)

    expect(view.container.querySelector('use[href="#opencode-icon-plus"]')).toBeTruthy()
  })

  test("renders Claxedo glyphs in icon buttons", () => {
    const view = render(() => <ClaxedoIconButton icon="reload" aria-label="Reload" />)

    expect(view.container.querySelector('button[data-icon="reload"]')).toBeTruthy()
    expect(view.container.querySelector('use[href="#claxedo-icon-reload"]')).toBeTruthy()
  })
})
