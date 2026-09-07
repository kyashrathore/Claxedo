import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library"
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

// jsdom has no PointerEvent, so the trigger opens from its keyboard path and the
// items select from a MouseEvent carrying the button Kobalte checks.
async function openMenu() {
  fireEvent.keyDown(pill(), { key: "Enter" })
  return await screen.findByTestId("review-compare-menu")
}

const menuItems = (menu: HTMLElement) => within(menu).getAllByRole("menuitem").map((item) => item.textContent?.trim())
const choose = (menu: HTMLElement, label: string | RegExp) =>
  within(menu).getByRole("menuitem", { name: label }).dispatchEvent(new MouseEvent("pointerup", { button: 0, bubbles: true }))

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

  test("lists uncommitted, then local branches, remote branches, tags and recent commits", async () => {
    renderToolbar()
    const menu = await openMenu()
    expect(menuItems(menu)).toEqual([
      "Uncommitted changes",
      "main",
      "feat/x",
      "origin/main",
      "origin/release",
      "v1.0.0",
      "abc1234fix: the thing",
    ])
    expect(menu.textContent).toContain("Compare against")
    const labels = [...menu.querySelectorAll('[data-slot="dropdown-menu-group-label"]')].map((el) => el.textContent)
    expect(labels).toEqual(["Compare against", "Branches", "Remote branches", "Tags", "Commits"])
  })

  test("omits a group whose fixture is empty", async () => {
    renderToolbar({ vcsRefs: { branches: ["main"], tags: [], recent: [] } })
    const menu = await openMenu()
    expect(menuItems(menu)).toEqual(["Uncommitted changes", "main"])
    const labels = [...menu.querySelectorAll('[data-slot="dropdown-menu-group-label"]')].map((el) => el.textContent)
    expect(labels).toEqual(["Compare against", "Branches"])
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
