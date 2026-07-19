import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library"
import { createComponent } from "solid-js"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { Persist, setPersisted } from "@/platform/persistence/persist"
import {
  SessionEnvironmentCard,
  createSessionEnvironmentCardState,
  type SessionEnvironmentSource,
} from "./session-environment-card"

// Persisted collapse lives in localStorage AND the persistence layer's
// module-level memory cache; `localStorage.clear()` alone does not reset the
// cache, so write the first-visit default (expanded) back per test.
beforeEach(() => {
  localStorage.clear()
  setPersisted(Persist.global("session.environment-card-collapsed.v1"), { collapsed: false })
})
afterEach(cleanup)

function source(overrides?: Partial<SessionEnvironmentSource>): SessionEnvironmentSource {
  return {
    changes: () => ({ files: 3, added: 12, removed: 4 }),
    branch: () => "codex/feat-documents-core",
    isolation: () => "worktree",
    worktreeDir: () => "/Users/me/.worktrees/opencode-fix",
    projectName: () => "opencode",
    ...overrides,
  }
}

const card = () => screen.getByRole("complementary", { name: "Session environment" })

describe("SessionEnvironmentCard", () => {
  test("renders as a bounded floating card with non-interactive facts", () => {
    render(() =>
      createComponent(SessionEnvironmentCard, {
        source: source(),
        onOpenTab: () => {},
      }),
    )
    // Bounded card surface, not the chromeless rail column.
    expect(card()).toHaveClass("is-floating")

    // Worktree + branch facts, values as trailing meta. A dedicated worktree
    // is named by its directory basename.
    expect(within(card()).getByText("Worktree")).toBeInTheDocument()
    expect(within(card()).getByText("opencode-fix")).toBeInTheDocument()
    expect(within(card()).getByText("codex/feat-documents-core")).toBeInTheDocument()

    // Facts are not buttons — navigation lives only in the nav section.
    expect(within(card()).getByText("Worktree").closest("button")).toBeNull()
    expect(within(card()).getByText("codex/feat-documents-core").closest("button")).toBeNull()
  })

  test("shows Changes exactly once — on the navigation row, carrying the +N −M metric", () => {
    render(() =>
      createComponent(SessionEnvironmentCard, {
        source: source(),
        onOpenTab: () => {},
      }),
    )
    expect(within(card()).getAllByText("Changes")).toHaveLength(1)
    const changesRow = within(card()).getByRole("button", { name: /Changes/ })
    expect(within(changesRow).getByText("+12")).toBeInTheDocument()
    expect(within(changesRow).getByText("−4")).toBeInTheDocument()
  })

  test("shows 'Clean' on the Changes row when the working tree has no changes", () => {
    render(() =>
      createComponent(SessionEnvironmentCard, {
        source: source({ changes: () => ({ files: 0, added: 0, removed: 0 }) }),
        onOpenTab: () => {},
      }),
    )
    const changesRow = within(card()).getByRole("button", { name: /Changes/ })
    expect(within(changesRow).getByText("Clean")).toBeInTheDocument()
  })

  test("omits the Branch row entirely for non-git directories", () => {
    render(() =>
      createComponent(SessionEnvironmentCard, {
        source: source({ branch: () => undefined }),
        onOpenTab: () => {},
      }),
    )
    expect(within(card()).queryByText("Branch")).toBeNull()
    expect(within(card()).queryByText("—")).toBeNull()
  })

  test("names the worktree: Main for the main checkout, Cloud for remote sandboxes", () => {
    const local = render(() =>
      createComponent(SessionEnvironmentCard, {
        source: source({ isolation: () => "local", worktreeDir: () => "/Users/me/opencode" }),
        onOpenTab: () => {},
      }),
    )
    expect(within(card()).getByText("Worktree")).toBeInTheDocument()
    expect(within(card()).getByText("Main")).toBeInTheDocument()
    local.unmount()

    render(() =>
      createComponent(SessionEnvironmentCard, {
        source: source({ isolation: () => "cloud" }),
        onOpenTab: () => {},
      }),
    )
    expect(within(card()).getByText("Cloud")).toBeInTheDocument()
    expect(within(card()).queryByText("Main")).toBeNull()
  })

  test("navigation rows open their respective panel tabs", async () => {
    const onOpenTab = vi.fn()
    render(() =>
      createComponent(SessionEnvironmentCard, {
        source: source(),
        onOpenTab,
      }),
    )
    const nav = within(card()).getByRole("region", { name: "On opencode" })
    await fireEvent.click(within(nav).getByRole("button", { name: /Changes/ }))
    await fireEvent.click(within(nav).getByRole("button", { name: "Files" }))
    await fireEvent.click(within(nav).getByRole("button", { name: "Processes" }))
    expect(onOpenTab).toHaveBeenNthCalledWith(1, "changes")
    expect(onOpenTab).toHaveBeenNthCalledWith(2, "files")
    expect(onOpenTab).toHaveBeenNthCalledWith(3, "processes")
  })

  test("collapse is a route-restorable preference that survives a remount", async () => {
    function Harness() {
      const collapse = createSessionEnvironmentCardState()
      return createComponent(SessionEnvironmentCard, {
        source: source(),
        get collapsed() {
          return collapse.collapsed()
        },
        onToggleCollapse: collapse.toggle,
        onOpenTab: () => {},
      })
    }

    const first = render(() => createComponent(Harness, {}))
    // Expanded by default: the navigation rows are visible.
    expect(screen.getByRole("button", { name: /Changes/ })).toBeInTheDocument()
    await fireEvent.click(screen.getByRole("button", { name: "Collapse Environment" }))
    // Collapsed: rows fold into the vertical icon rail, which keeps the tab
    // glyph buttons (labelled by their action).
    expect(screen.queryByRole("button", { name: /Changes/ })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Open changes" })).toBeInTheDocument()

    // A fresh mount reads the persisted preference and stays collapsed.
    first.unmount()
    render(() => createComponent(Harness, {}))
    expect(screen.getByRole("button", { name: "Expand Environment" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Changes/ })).not.toBeInTheDocument()
  })
})
