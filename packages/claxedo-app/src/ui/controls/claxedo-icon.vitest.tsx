import { cleanup, render } from "@solidjs/testing-library"
import { afterEach, describe, expect, test } from "vitest"
import { ClaxedoIcon } from "@/ui/controls/claxedo-icon"
import { ClaxedoIconButton } from "@/ui/controls/claxedo-icon-button"

describe("ClaxedoIcon", () => {
  afterEach(() => cleanup())

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
