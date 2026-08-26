import { cleanup, render } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { ReviewToolbar } from "./review-toolbar"

vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

vi.mock("@/ui/controls/portal-slot", () => ({
  reviewControlsSlot: () => null,
  reviewToolbarSlot: () => null,
}))

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
