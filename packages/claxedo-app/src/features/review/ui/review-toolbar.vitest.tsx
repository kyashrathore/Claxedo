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
    defaultBaseRef?: string
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
      defaultBaseRef={input.defaultBaseRef}
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
const WORKTREE_ROWS = ["Uncommitted changes", "Staged changes", "Unstaged changes"]
const baseButton = (menu: HTMLElement) => within(menu).getByTestId("review-compare-base")

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

  test("lists the worktree modes, then local branches, remote branches, tags and recent commits", async () => {
    renderToolbar()
    const menu = await openMenu()
    expect(options(menu)).toEqual([
      ...WORKTREE_ROWS,
      "main",
      "feat/x",
      "origin/main",
      "origin/release",
      "v1.0.0",
      "abc1234fix: the thing",
    ])
    expect(groupLabels(menu)).toEqual(["Branches", "Remote branches", "Tags", "Commits"])
    expect(menu.textContent).toContain("Compare against")
  })

  test("with no base to measure from, offers no branch modes and asks for a base", async () => {
    renderToolbar()
    const menu = await openMenu()
    expect(within(menu).queryByTestId("review-compare-branch")).toBeNull()
    expect(baseButton(menu).textContent).toBe("Choose base")
  })

  test("with a default base, the header names it and the branch modes measure from it", async () => {
    const onApplyMode = vi.fn()
    renderToolbar({ defaultBaseRef: "origin/main", onApplyMode })
    const menu = await openMenu()
    expect(baseButton(menu).textContent).toBe("against origin/main")
    expect(options(menu).slice(0, 5)).toEqual([...WORKTREE_ROWS, "Branch changes", "Everything since origin/main"])

    choose(menu, "Branch changes")
    expect(onApplyMode).toHaveBeenLastCalledWith("branch", "origin/main", "")
    choose(await openMenu(), "Everything since origin/main")
    expect(onApplyMode).toHaveBeenLastCalledWith("branch-worktree", "origin/main", "")
  })

  test("in a branch mode, the base on screen wins over the default", async () => {
    renderToolbar({ mode: "branch", fromRef: "feat/x", defaultBaseRef: "main", currentBranch: "topic" })
    expect(pillText()).toBe("feat/x topic")
    const menu = await openMenu()
    expect(baseButton(menu).textContent).toBe("against feat/x")
    expect(options(menu)).toContain("Everything since feat/x")
  })

  test("reads base → working tree in branch-worktree mode", () => {
    renderToolbar({ mode: "branch-worktree", fromRef: "main", currentBranch: "topic" })
    expect(pillText()).toBe("main working tree")
  })

  test("the base button opens a base picker with the default pinned; choosing keeps a branch mode or enters branch", async () => {
    const onApplyMode = vi.fn()
    renderToolbar({ defaultBaseRef: "main", onApplyMode })
    fireEvent.click(baseButton(await openMenu()))
    const baseMenu = await screen.findByTestId("review-base-menu")
    await waitFor(() => expect(document.activeElement).toBe(search(baseMenu)))
    expect(options(baseMenu)).toEqual(["main", "feat/x", "origin/main", "origin/release", "v1.0.0"])
    expect(groupLabels(baseMenu)).toEqual(["Default branch", "Branches", "Remote branches", "Tags"])

    fireEvent.click(within(baseMenu).getByTestId("review-base-back"))
    expect(await screen.findByTestId("review-compare-menu")).toBeTruthy()
    fireEvent.click(baseButton(screen.getByTestId("review-compare-menu")))
    choose(await screen.findByTestId("review-base-menu"), "origin/release")
    expect(onApplyMode).toHaveBeenLastCalledWith("branch", "origin/release", "")
    await waitFor(() => expect(pill().getAttribute("aria-expanded")).toBe("false"))
    cleanup()

    renderToolbar({ mode: "branch-worktree", fromRef: "main", defaultBaseRef: "main", onApplyMode })
    fireEvent.click(baseButton(await openMenu()))
    choose(await screen.findByTestId("review-base-menu"), "feat/x")
    expect(onApplyMode).toHaveBeenLastCalledWith("branch-worktree", "feat/x", "")
  })

  test("a reopened picker starts on the compare view", async () => {
    renderToolbar({ defaultBaseRef: "main" })
    fireEvent.click(baseButton(await openMenu()))
    fireEvent.keyDown(search(await screen.findByTestId("review-base-menu")), { key: "Escape" })
    await waitFor(() => expect(pill().getAttribute("aria-expanded")).toBe("false"))
    expect(await openMenu()).toBeTruthy()
  })

  test("omits a group whose fixture is empty", async () => {
    renderToolbar({ vcsRefs: { branches: ["main"], tags: [], recent: [] } })
    const menu = await openMenu()
    expect(options(menu)).toEqual([...WORKTREE_ROWS, "main"])
    expect(groupLabels(menu)).toEqual(["Branches"])
  })

  test("focuses the search on open and filters every group by substring, keeping the mode rows", async () => {
    renderToolbar()
    const menu = await openMenu()
    await waitFor(() => expect(document.activeElement).toBe(search(menu)))

    fireEvent.input(search(menu), { target: { value: "MAIN" } })
    expect(options(menu)).toEqual([...WORKTREE_ROWS, "main", "origin/main"])
    expect(groupLabels(menu)).toEqual(["Branches", "Remote branches"])

    fireEvent.input(search(menu), { target: { value: "thing" } })
    expect(options(menu)).toEqual([...WORKTREE_ROWS, "abc1234fix: the thing"])

    fireEvent.input(search(menu), { target: { value: "nothing here" } })
    expect(options(menu)).toEqual(WORKTREE_ROWS)
    expect(within(menu).getByTestId("review-compare-no-matches").textContent).toBe("navigator.sourceControl.compare.noMatches")
  })

  test("arrow keys walk the filtered list and Enter measures the active branch from where HEAD left it", async () => {
    const onApplyMode = vi.fn()
    renderToolbar({ onApplyMode })
    const menu = await openMenu()
    const input = search(menu)
    fireEvent.input(input, { target: { value: "origin" } })
    expect(options(menu)).toEqual([...WORKTREE_ROWS, "origin/main", "origin/release"])
    const selected = () => within(menu).getByRole("option", { selected: true }).textContent

    expect(selected()).toBe("Uncommitted changes")
    fireEvent.keyDown(input, { key: "End" })
    expect(selected()).toBe("origin/release")
    expect(input.getAttribute("aria-activedescendant")).toBe(within(menu).getByRole("option", { selected: true }).id)
    fireEvent.keyDown(input, { key: "ArrowDown" })
    expect(selected()).toBe("Uncommitted changes")
    fireEvent.keyDown(input, { key: "ArrowUp" })
    expect(selected()).toBe("origin/release")

    fireEvent.keyDown(input, { key: "Enter" })
    expect(onApplyMode).toHaveBeenCalledWith("branch", "origin/release", "")
    await waitFor(() => expect(pill().getAttribute("aria-expanded")).toBe("false"))
  })

  test("choosing a branch or tag enters branch mode; choosing a commit compares it against HEAD", async () => {
    const onApplyMode = vi.fn()
    renderToolbar({ onApplyMode })
    choose(await openMenu(), "v1.0.0")
    expect(onApplyMode).toHaveBeenLastCalledWith("branch", "v1.0.0", "")
    choose(await openMenu(), /fix: the thing/)
    expect(onApplyMode).toHaveBeenLastCalledWith("to-from", "abc1234", "HEAD")
  })

  test("choosing a worktree mode leaves any ref comparison", async () => {
    const onApplyMode = vi.fn()
    renderToolbar({ mode: "to-from", fromRef: "dev", toRef: "HEAD", currentBranch: "feat/x", onApplyMode })
    choose(await openMenu(), "Uncommitted changes")
    expect(onApplyMode).toHaveBeenLastCalledWith("uncommitted", "", "")
    choose(await openMenu(), "Staged changes")
    expect(onApplyMode).toHaveBeenLastCalledWith("staged", "", "")
    choose(await openMenu(), "Unstaged changes")
    expect(onApplyMode).toHaveBeenLastCalledWith("unstaged", "", "")
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
