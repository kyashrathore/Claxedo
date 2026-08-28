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
// cache. Tests that need an expanded card set that preference themselves.
beforeEach(() => {
  localStorage.clear()
  setPersisted(Persist.global("session.environment-card-collapsed.v2"), {
    collapsedBySessionId: {},
    recency: [],
  })
})
afterEach(cleanup)

function source(overrides?: Partial<SessionEnvironmentSource>): SessionEnvironmentSource {
  return {
    changes: () => ({ files: 3, added: 12, removed: 4 }),
    branch: () => "codex/feat-documents-core",
    isolation: () => "worktree",
    worktreeDir: () => "/Users/me/.worktrees/opencode-fix",
    projectName: () => "opencode",
    repoSlug: () => "kyashrathore/Claxedo",
    processes: () => undefined,
    ...overrides,
  }
}

const card = () => screen.getByRole("complementary", { name: "Session environment" })

describe("SessionEnvironmentCard", () => {
  test("renders worktree and branch facts as rows that copy their visible values", async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    })
    render(() =>
      createComponent(SessionEnvironmentCard, {
        source: source(),
        onOpenTab: () => {},
      }),
    )
    // Bounded card surface, not the chromeless rail column.
    expect(card()).toHaveClass("is-floating")

    // Worktree + branch facts are icon-led: the row text IS the value (no
    // "Worktree:" / "Branch:" field label). A dedicated worktree is named by
    // its directory basename.
    expect(within(card()).getByText("opencode-fix")).toBeInTheDocument()
    expect(within(card()).getByText("codex/feat-documents-core")).toBeInTheDocument()
    expect(card().querySelector('[data-icon="worktree"]')).not.toBeNull()

    const worktree = within(card()).getByRole("button", { name: "Copy worktree name opencode-fix" })
    const branch = within(card()).getByRole("button", { name: "Copy branch name codex/feat-documents-core" })
    expect(worktree.querySelector('[data-icon="copy"]')).not.toBeNull()
    expect(branch.querySelector('[data-icon="copy"]')).not.toBeNull()

    await fireEvent.click(worktree)
    await fireEvent.click(branch)

    expect(writeText).toHaveBeenNthCalledWith(1, "opencode-fix")
    expect(writeText).toHaveBeenNthCalledWith(2, "codex/feat-documents-core")
    expect(within(card()).getByRole("button", { name: "Copied worktree name opencode-fix" })).toBeInTheDocument()
    expect(within(card()).getByRole("button", { name: "Copied branch name codex/feat-documents-core" })).toBeInTheDocument()
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

  test("formats large diff counts with thousands separators", () => {
    render(() =>
      createComponent(SessionEnvironmentCard, {
        source: source({ changes: () => ({ files: 40, added: 13895, removed: 5075 }) }),
        onOpenTab: () => {},
      }),
    )
    const changesRow = within(card()).getByRole("button", { name: /Changes/ })
    expect(within(changesRow).getByText("+13,895")).toBeInTheDocument()
    expect(within(changesRow).getByText("−5,075")).toBeInTheDocument()
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

  test("opens the repository on its git host from the Repository row", async () => {
    const onOpenRepo = vi.fn()
    render(() =>
      createComponent(SessionEnvironmentCard, {
        source: source(),
        onOpenTab: () => {},
        onOpenRepo,
      }),
    )
    const repo = within(card()).getByRole("region", { name: "Repository" })
    await fireEvent.click(within(repo).getByRole("button", { name: /kyashrathore\/Claxedo/ }))
    expect(onOpenRepo).toHaveBeenCalledWith("kyashrathore/Claxedo")
  })

  test("omits the Repository row when the project has no known git remote", () => {
    render(() =>
      createComponent(SessionEnvironmentCard, {
        source: source({ repoSlug: () => undefined }),
        onOpenTab: () => {},
      }),
    )
    expect(within(card()).queryByRole("region", { name: "Repository" })).toBeNull()
  })

  test("shows a green running-count badge on the Processes row when servers are up", () => {
    render(() =>
      createComponent(SessionEnvironmentCard, {
        source: source({
          processes: () => ({
            configured: 2,
            running: [
              { id: "web", name: "web", port: 3000, url: "http://localhost:3000", ptyId: "pty-web" },
              { id: "api", name: "api", port: 4000, url: "http://localhost:4000", ptyId: "pty-api" },
            ],
          }),
        }),
        onOpenTab: () => {},
      }),
    )
    const trigger = within(card()).getByRole("button", { name: "Processes, 2 running" })
    // Running count as trailing meta, next to the green status dot.
    expect(within(trigger).getByText("2")).toBeInTheDocument()
    expect(trigger.querySelector(".session-envcard-dot-running")).not.toBeNull()
  })

  test("the Processes badge opens a popover to each running server's URL and terminal", async () => {
    const onOpenProcessTerminal = vi.fn()
    render(() =>
      createComponent(SessionEnvironmentCard, {
        source: source({
          processes: () => ({
            configured: 1,
            running: [{ id: "web", name: "web", port: 3000, url: "http://localhost:3000", ptyId: "pty-web" }],
          }),
        }),
        onOpenTab: () => {},
        onOpenProcessTerminal,
      }),
    )
    await fireEvent.click(within(card()).getByRole("button", { name: "Processes, 1 running" }))
    // The popover portals to document.body — query document-wide, not within the card.
    const link = await screen.findByRole("link", { name: "Open web in browser" })
    expect(link).toHaveAttribute("href", "http://localhost:3000")
    expect(link).toHaveAttribute("target", "_blank")
    await fireEvent.click(screen.getByRole("button", { name: "Open web terminal" }))
    expect(onOpenProcessTerminal).toHaveBeenCalledWith(expect.objectContaining({ id: "web", ptyId: "pty-web" }))
  })

  test("shows a quiet Idle meta when processes are configured but none are running", () => {
    render(() =>
      createComponent(SessionEnvironmentCard, {
        source: source({ processes: () => ({ configured: 2, running: [] }) }),
        onOpenTab: () => {},
      }),
    )
    const row = within(card()).getByRole("button", { name: /Processes/ })
    expect(within(row).getByText("Idle")).toBeInTheDocument()
  })

  test("offers to configure managed processes when none are set up", async () => {
    const onConfigureProcesses = vi.fn()
    render(() =>
      createComponent(SessionEnvironmentCard, {
        source: source({ processes: () => ({ configured: 0, running: [] }) }),
        onOpenTab: () => {},
        onConfigureProcesses,
      }),
    )
    // The plain "Processes" nav row is replaced by a set-up call-to-action.
    expect(within(card()).queryByRole("button", { name: "Processes" })).toBeNull()
    await fireEvent.click(within(card()).getByRole("button", { name: "Set up dev servers" }))
    expect(onConfigureProcesses).toHaveBeenCalledTimes(1)
  })

  test("collapse is a session-local preference that survives a remount of that session", async () => {
    function Harness() {
      const collapse = createSessionEnvironmentCardState()
      return createComponent(SessionEnvironmentCard, {
        source: source(),
        get collapsed() {
          return collapse.collapsed("ses_a")
        },
        onToggleCollapse: () => collapse.toggle("ses_a"),
        onOpenTab: () => {},
      })
    }

    const first = render(() => createComponent(Harness, {}))
    // Collapsed by default: the navigation rows fold into the vertical icon rail.
    expect(screen.getByRole("button", { name: "Expand Environment" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Changes/ })).not.toBeInTheDocument()
    await fireEvent.click(screen.getByRole("button", { name: "Expand Environment" }))
    expect(screen.getByRole("button", { name: /Changes/ })).toBeInTheDocument()

    // A fresh mount of the same session reads the persisted preference and stays expanded.
    first.unmount()
    render(() => createComponent(Harness, {}))
    expect(screen.getByRole("button", { name: "Collapse Environment" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Changes/ })).toBeInTheDocument()
  })

  test("expanding the card in one session leaves another session collapsed", async () => {
    const collapse = createSessionEnvironmentCardState()
    collapse.setCollapsed("ses_a", false)
    expect(collapse.collapsed("ses_a")).toBe(false)
    expect(collapse.collapsed("ses_b")).toBe(true)
  })
})
