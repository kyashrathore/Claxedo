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
    expect(sprite.querySelector("#claxedo-icon-worktree path")?.getAttribute("d")).toContain("M5 10H8.5")
    expect(sprite.querySelector("#claxedo-icon-worktree path")?.getAttribute("stroke-width")).toBe("1.25")
  })

  test("renders mapped Codex glyphs from the extracted sprite", () => {
    const view = render(() => (
      <>
        <ClaxedoIcon name="play" />
        <ClaxedoIcon name="archive" />
        <ClaxedoIcon name="changes" />
        <ClaxedoIcon name="folders" />
      </>
    ))

    expect(view.container.querySelector('use[href$="#codex-icon-sprite-codex-20-068"]')).toBeTruthy()
    expect(view.container.querySelector('use[href$="#codex-icon-sprite-codex-20-144"]')).toBeTruthy()
    // `changes` shares the boxed ± with `review` — see the note on the entry in
    // `@/ui/icons/codex`. It was codex-20-120 until 5197e0704 re-pointed it.
    expect(view.container.querySelector('use[href$="#codex-icon-sprite-codex-20-071"]')).toBeTruthy()
    expect(view.container.querySelector('use[href$="#codex-icon-sprite-codex-20-057"]')).toBeTruthy()
  })

  test("maps former upstream glyphs through the active Codex library", () => {
    const view = render(() => (
      <>
        <ClaxedoIcon name="plus" />
        <ClaxedoIcon name="scroll-to-latest" />
      </>
    ))

    expect(view.container.querySelector('[data-library="codex"]')).toBeTruthy()
    expect(view.container.querySelector('use[href$="#codex-icon-sprite-codex-20-006"]')).toBeTruthy()
    expect(view.container.querySelector('[data-icon="scroll-to-latest"] use')).toHaveAttribute(
      "href",
      expect.stringMatching(/#codex-icon-sprite-codex-20-002$/),
    )
    expect(view.container.querySelector('[data-icon="scroll-to-latest"] use')).toHaveAttribute(
      "transform",
      "rotate(180 10 10)",
    )
  })

  test("keeps exact Codex state glyphs in the local custom sprite", () => {
    const view = render(() => (
      <>
        <ClaxedoIcon name="dot-grid" />
        <ClaxedoIcon name="file-text" />
        <ClaxedoIcon name="page-plus" />
        <ClaxedoIcon name="copy" />
        <ClaxedoIcon name="folder" />
        <ClaxedoIcon name="pin" />
        <ClaxedoIcon name="pin-filled" />
        <ClaxedoIcon name="folder-open" />
        <ClaxedoIcon name="expand" />
        <ClaxedoIcon name="collapse" />
        <ClaxedoIcon name="expand-all" />
        <ClaxedoIcon name="collapse-all" />
        <ClaxedoIcon name="split" />
        <ClaxedoIcon name="unified" />
        <ClaxedoIcon name="worktree" />
        <ClaxedoIcon name="marketplace" />
        <ClaxedoIcon name="providers" />
        <ClaxedoIcon name="models" />
      </>
    ))

    expect(view.container.querySelector('use[href="#claxedo-icon-more-horizontal"]')).toBeTruthy()
    expect(view.container.querySelector('use[href="#claxedo-icon-file"]')).toBeTruthy()
    expect(view.container.querySelector('use[href="#claxedo-icon-page-plus"]')).toBeTruthy()
    expect(view.container.querySelector('use[href="#claxedo-icon-copy"]')).toHaveAttribute(
      "transform",
      "translate(-2 -2) scale(1.2)",
    )
    expect(view.container.querySelector('use[href="#claxedo-icon-folder"]')).toBeTruthy()
    expect(view.container.querySelector('use[href="#claxedo-icon-pin"]')).toBeTruthy()
    expect(view.container.querySelector('use[href="#claxedo-icon-pin-filled"]')).toBeTruthy()
    expect(view.container.querySelector('use[href="#claxedo-icon-folder-open"]')).toBeTruthy()
    expect(view.container.querySelector('use[href="#claxedo-icon-panel-expand"]')).toBeTruthy()
    expect(view.container.querySelector('use[href="#claxedo-icon-panel-restore"]')).toBeTruthy()
    expect(view.container.querySelector('use[href="#claxedo-icon-expand-all"]')).toBeTruthy()
    expect(view.container.querySelector('use[href="#claxedo-icon-collapse-all"]')).toBeTruthy()
    expect(view.container.querySelector('use[href="#claxedo-icon-diff-split"]')).toBeTruthy()
    expect(view.container.querySelector('use[href="#claxedo-icon-diff-unified"]')).toBeTruthy()
    expect(view.container.querySelector('use[href="#claxedo-icon-worktree"]')).toBeTruthy()
    expect(view.container.querySelector('use[href="#claxedo-icon-marketplace"]')).toBeTruthy()
    expect(view.container.querySelector('use[href="#claxedo-icon-providers"]')).toBeTruthy()
    expect(view.container.querySelector('use[href="#claxedo-icon-models"]')).toBeTruthy()
  })

  test("keeps left and right panel states on their mirrored Codex glyphs", () => {
    const view = render(() => (
      <>
        <ClaxedoIcon name="layout-left-partial" />
        <ClaxedoIcon name="layout-left-full" />
        <ClaxedoIcon name="sidebar-active" />
        <ClaxedoIcon name="layout-right-partial" />
        <ClaxedoIcon name="layout-right-full" />
        <ClaxedoIcon name="sidebar-right" />
      </>
    ))

    expect(view.container.querySelector('[data-icon="layout-left-partial"] use')).toHaveAttribute(
      "href",
      expect.stringMatching(/#codex-icon-sprite-codex-20-034$/),
    )
    expect(view.container.querySelector('[data-icon="layout-left-full"] use')).toHaveAttribute(
      "href",
      expect.stringMatching(/#codex-icon-sprite-codex-20-035$/),
    )
    expect(view.container.querySelector('[data-icon="sidebar-active"] use')).toHaveAttribute(
      "href",
      expect.stringMatching(/#codex-icon-sprite-codex-20-035$/),
    )
    expect(view.container.querySelector('[data-icon="layout-right-partial"] use')).toHaveAttribute(
      "href",
      expect.stringMatching(/#codex-icon-sprite-codex-20-034$/),
    )
    expect(view.container.querySelector('[data-icon="layout-right-full"] use')).toHaveAttribute(
      "href",
      expect.stringMatching(/#codex-icon-sprite-codex-20-035$/),
    )
    expect(view.container.querySelector('[data-icon="sidebar-right"] use')).toHaveAttribute(
      "href",
      expect.stringMatching(/#codex-icon-sprite-codex-20-034$/),
    )
    for (const name of ["layout-right-partial", "layout-right-full", "sidebar-right"]) {
      expect(view.container.querySelector(`[data-icon="${name}"] use`)).toHaveAttribute(
        "transform",
        "rotate(180 10 10)",
      )
    }
  })

  test("renders Claxedo glyphs in icon buttons", () => {
    const view = render(() => (
      <>
        <ClaxedoIconButton icon="reload" aria-label="Reload" />
        <ClaxedoIconButton icon="sidebar" aria-label="Sidebar" aria-pressed="true" data-icon-interaction="binary" />
      </>
    ))

    expect(view.container.querySelector('button[data-icon="reload"]')).toHaveAttribute(
      "data-icon-interaction",
      "persistent",
    )
    expect(view.container.querySelector('use[href$="#codex-icon-sprite-codex-20-004"]')).toBeTruthy()
    expect(view.container.querySelector('button[data-icon="sidebar"]')).toHaveAttribute(
      "data-icon-interaction",
      "binary",
    )
  })

  // The send arrow sits inside a filled circle and has to stay legible against
  // it. That takes two halves: the persistent default emitted here, and the
  // inverse-foreground rule keyed on it in `app/styles/ui-overrides.css`. This
  // asserts the half this component owns — that a default primary icon button
  // is still the element that rule selects.
  test("a default primary icon button matches the inverse-foreground rule", () => {
    const view = render(() => <ClaxedoIconButton icon="send" variant="primary" aria-label="Send" />)
    const button = view.container.querySelector('button[data-icon="send"]')

    expect(
      button?.matches('[data-component="icon-button"][data-variant="primary"][data-icon-interaction="persistent"]'),
    ).toBe(true)
  })
})
