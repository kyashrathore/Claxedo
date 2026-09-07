import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { ReviewMode } from "@/features/review/review-intent"
import { ReviewToolbar } from "./review-toolbar"

vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

vi.mock("@/ui/controls/portal-slot", () => ({
  reviewControlsSlot: () => null,
  reviewToolbarSlot: () => null,
}))

const refs = { branches: ["main", "feat/x"], tags: [], recent: [] }

function renderToolbar(input: { mode?: ReviewMode; fromRef?: string; toRef?: string; onApplyMode?: (mode: ReviewMode, from: string, to: string) => void } = {}) {
  return render(() => (
    <ReviewToolbar
      mode={input.mode ?? "uncommitted"}
      fromRef={input.fromRef ?? ""}
      toRef={input.toRef ?? ""}
      vcsRefs={refs}
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

const trigger = (label: string) => screen.getByRole("button", { name: new RegExp(label) })

async function openCompare(label: string) {
  fireEvent.click(trigger(label))
  return await screen.findByTestId("review-compare-popover")
}

const apply = () => screen.getByTestId("review-compare-apply") as HTMLButtonElement
const picker = (label: "From" | "To") => screen.getByPlaceholderText(label === "From" ? "HEAD~1" : "HEAD") as HTMLInputElement

describe("ReviewToolbar compare popover", () => {
  afterEach(() => cleanup())

  test("opens on the mode trigger with both ref pickers and Apply disabled until both are filled", async () => {
    renderToolbar()
    const popover = await openCompare("Uncommitted")
    expect(popover.textContent).toContain("Compare against")
    expect(picker("From").value).toBe("")
    expect(picker("To").value).toBe("")
    expect(apply().disabled).toBe(true)

    fireEvent.input(picker("From"), { target: { value: "main" } })
    expect(apply().disabled).toBe(true)
    fireEvent.input(picker("To"), { target: { value: "HEAD" } })
    expect(apply().disabled).toBe(false)
  })

  test("Apply applies the to-from range and closes", async () => {
    const onApplyMode = vi.fn()
    renderToolbar({ onApplyMode })
    await openCompare("Uncommitted")
    fireEvent.input(picker("From"), { target: { value: "main" } })
    fireEvent.input(picker("To"), { target: { value: "feat/x" } })
    fireEvent.click(apply())
    expect(onApplyMode).toHaveBeenCalledWith("to-from", "main", "feat/x")
    await waitFor(() => expect(trigger("Uncommitted").getAttribute("aria-expanded")).toBe("false"))
  })

  test("the pickers start from the applied range and Back to uncommitted only exists in to-from mode", async () => {
    const onApplyMode = vi.fn()
    renderToolbar({ mode: "to-from", fromRef: "main", toRef: "HEAD", onApplyMode })
    await openCompare("to / from")
    expect(picker("From").value).toBe("main")
    expect(picker("To").value).toBe("HEAD")
    fireEvent.click(screen.getByTestId("review-compare-back"))
    expect(onApplyMode).toHaveBeenCalledWith("uncommitted", "", "")
    await waitFor(() => expect(trigger("to / from").getAttribute("aria-expanded")).toBe("false"))
    cleanup()

    renderToolbar({ mode: "staged" })
    await openCompare("Staged")
    expect(screen.queryByTestId("review-compare-back")).toBeNull()
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
