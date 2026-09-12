import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { ReviewMode } from "@/features/review/review-intent"
import { ReviewToolbar, type VcsRefs } from "./review-toolbar"

vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

vi.mock("@/ui/controls/portal-slot", () => ({
  reviewControlsSlot: () => null,
  reviewToolbarSlot: () => null,
}))

const refs: VcsRefs = {
  branches: ["main", "feat/x", "origin/main", "origin/release"],
  tags: ["v1.0.0"],
  recent: [{ hash: "abc1234", subject: "fix: the thing" }],
}

function renderToolbar(
  input: {
    mode?: ReviewMode
    fromRef?: string
    toRef?: string
    currentBranch?: string
    vcsRefs?: VcsRefs
    onApplyMode?: (mode: ReviewMode, from: string, to: string) => void
  } = {},
) {
  return render(() => (
    <ReviewToolbar
      mode={input.mode ?? "uncommitted"}
      fromRef={input.fromRef ?? ""}
      toRef={input.toRef ?? ""}
      currentBranch={input.currentBranch}
      vcsRefs={input.vcsRefs ?? refs}
      onApplyMode={input.onApplyMode ?? (() => undefined)}
      hasReview
      loading={false}
      reviewCount={3}
      totalChanges={{ additions: 3, deletions: 1 }}
      scopeLabel="scope"
      hasExpandedDiffs={false}
      onToggleAllDiffs={() => undefined}
      diffStyle="unified"
      onSetDiffStyle={() => undefined}
    />
  ))
}

const pill = () => screen.getByTestId("review-compare-trigger")
const pillText = () => [...pill().querySelectorAll(":scope > span")].map((span) => span.textContent).join(" ")

async function openMenu() {
  fireEvent.click(pill())
  return await screen.findByTestId("review-compare-menu")
}

const search = (menu: HTMLElement): HTMLInputElement => within(menu).getByTestId("review-compare-search")
const options = (menu: HTMLElement) => within(menu).getAllByRole("option").map((item) => item.textContent?.trim())
const choose = (menu: HTMLElement, label: string | RegExp) => fireEvent.click(within(menu).getByRole("option", { name: label }))
const groupLabels = (menu: HTMLElement) =>
  [...menu.querySelectorAll('[role="listbox"] > div:not([role="option"]):not([data-testid])')].map((el) => el.textContent)

describe("ReviewToolbar compare pill", () => {
  afterEach(() => cleanup())

  test("reads the mode and count outside to-from mode", () => {
    renderToolbar({ mode: "uncommitted" })
    expect(pillText()).toBe("Uncommitted 3")
    cleanup()
    renderToolbar({ mode: "staged" })
    expect(pillText()).toBe("Staged 3")
    cleanup()
    renderToolbar({ mode: "unstaged" })
    expect(pillText()).toBe("Unstaged 3")
  })

  test("reads base → head in to-from mode, naming HEAD after the checked-out branch", () => {
    renderToolbar({ mode: "to-from", fromRef: "dev", toRef: "HEAD", currentBranch: "codex/claxedo-test-quality-audit" })
    expect(pillText()).toBe("dev codex/claxedo-test-quality-audit")
    expect(pill().querySelector('[data-slot="icon-svg"]')).not.toBeNull()
    cleanup()
    renderToolbar({ mode: "to-from", fromRef: "dev", toRef: "HEAD" })
    expect(pillText()).toBe("dev HEAD")
    cleanup()
    renderToolbar({ mode: "to-from", fromRef: "main", toRef: "feat/x", currentBranch: "dev" })
    expect(pillText()).toBe("main feat/x")
  })

  test("abbreviates full commit hashes on both sides of the pill", () => {
    renderToolbar({
      mode: "to-from",
      fromRef: "2222222222222222222222222222222222222222",
      toRef: "1111111111111111111111111111111111111111",
      currentBranch: "dev",
    })
    expect(pillText()).toBe("2222222 1111111")
  })

  test("lists uncommitted, then local branches, remote branches, tags and recent commits", async () => {
    renderToolbar()
    const menu = await openMenu()
    expect(options(menu)).toEqual([
      "Uncommitted changes",
      "main",
      "feat/x",
      "origin/main",
      "origin/release",
      "v1.0.0",
      "abc1234fix: the thing",
    ])
    expect(groupLabels(menu)).toEqual(["Compare against", "Branches", "Remote branches", "Tags", "Commits"])
  })

  test("omits a group whose fixture is empty", async () => {
    renderToolbar({ vcsRefs: { branches: ["main"], tags: [], recent: [] } })
    const menu = await openMenu()
    expect(options(menu)).toEqual(["Uncommitted changes", "main"])
    expect(groupLabels(menu)).toEqual(["Compare against", "Branches"])
  })

  test("focuses the search on open and filters every group by substring, keeping Uncommitted", async () => {
    renderToolbar()
    const menu = await openMenu()
    await waitFor(() => expect(document.activeElement).toBe(search(menu)))

    fireEvent.input(search(menu), { target: { value: "MAIN" } })
    expect(options(menu)).toEqual(["Uncommitted changes", "main", "origin/main"])
    expect(groupLabels(menu)).toEqual(["Compare against", "Branches", "Remote branches"])

    fireEvent.input(search(menu), { target: { value: "thing" } })
    expect(options(menu)).toEqual(["Uncommitted changes", "abc1234fix: the thing"])

    fireEvent.input(search(menu), { target: { value: "nothing here" } })
    expect(options(menu)).toEqual(["Uncommitted changes"])
    expect(within(menu).getByTestId("review-compare-no-matches").textContent).toBe("navigator.sourceControl.compare.noMatches")
  })

  test("arrow keys walk the filtered list and Enter compares the active ref against HEAD", async () => {
    const onApplyMode = vi.fn()
    renderToolbar({ onApplyMode })
    const menu = await openMenu()
    const input = search(menu)
    fireEvent.input(input, { target: { value: "origin" } })
    expect(options(menu)).toEqual(["Uncommitted changes", "origin/main", "origin/release"])
    const selected = () => within(menu).getByRole("option", { selected: true }).textContent

    expect(selected()).toBe("Uncommitted changes")
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "ArrowDown" })
    expect(selected()).toBe("origin/release")
    expect(input.getAttribute("aria-activedescendant")).toBe(within(menu).getByRole("option", { selected: true }).id)
    fireEvent.keyDown(input, { key: "ArrowDown" })
    expect(selected()).toBe("Uncommitted changes")
    fireEvent.keyDown(input, { key: "ArrowUp" })
    expect(selected()).toBe("origin/release")

    fireEvent.keyDown(input, { key: "Enter" })
    expect(onApplyMode).toHaveBeenCalledWith("to-from", "origin/release", "HEAD")
    await waitFor(() => expect(pill().getAttribute("aria-expanded")).toBe("false"))
  })

  test("choosing a ref compares it against HEAD", async () => {
    const onApplyMode = vi.fn()
    renderToolbar({ onApplyMode })
    choose(await openMenu(), "origin/release")
    expect(onApplyMode).toHaveBeenCalledWith("to-from", "origin/release", "HEAD")
    cleanup()

    onApplyMode.mockClear()
    renderToolbar({ onApplyMode })
    choose(await openMenu(), /fix: the thing/)
    expect(onApplyMode).toHaveBeenCalledWith("to-from", "abc1234", "HEAD")
  })

  test("choosing Uncommitted changes leaves to-from mode", async () => {
    const onApplyMode = vi.fn()
    renderToolbar({ mode: "to-from", fromRef: "dev", toRef: "HEAD", currentBranch: "feat/x", onApplyMode })
    choose(await openMenu(), "Uncommitted changes")
    expect(onApplyMode).toHaveBeenCalledWith("uncommitted", "", "")
  })

  test("Escape closes the picker", async () => {
    renderToolbar()
    const menu = await openMenu()
    expect(pill().getAttribute("aria-expanded")).toBe("true")
    fireEvent.keyDown(search(menu), { key: "Escape" })
    await waitFor(() => expect(pill().getAttribute("aria-expanded")).toBe("false"))
  })
})

describe("ReviewToolbar", () => {
  afterEach(() => cleanup())

  test("identifies its all-diffs action as Collapse all when any diff is expanded", () => {
    const view = render(() => (
      <ReviewToolbar
        mode="uncommitted"
        fromRef=""
        toRef=""
        vcsRefs={{ branches: [], tags: [], recent: [] }}
        onApplyMode={() => undefined}
        hasReview
        loading={false}
        reviewCount={24}
        totalChanges={{ additions: 24, deletions: 24 }}
        scopeLabel="Uncommitted"
        hasExpandedDiffs
        onToggleAllDiffs={() => undefined}
        diffStyle="unified"
        onSetDiffStyle={() => undefined}
      />
    ))

    expect(view.getByLabelText("ui.sessionReview.collapseAll")).toBeTruthy()
    expect(view.queryByLabelText("ui.sessionReview.expandAll")).toBeNull()
  })
})
