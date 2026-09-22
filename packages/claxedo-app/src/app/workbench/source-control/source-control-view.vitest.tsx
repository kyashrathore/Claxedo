import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createSignal, type JSX } from "solid-js"
import { WorkspaceGitError, type GitCommitSummary, type GitWorktreeStatus } from "@/platform/runtime/workspace-git-client"
import { createPanePreferences, type ReviewSelection } from "@/features/session/preferences/pane"

type PendingAction = "stage" | "unstage" | "commit" | "push" | undefined

const h = vi.hoisted(() => ({
  status: undefined as GitWorktreeStatus | undefined,
  commits: [] as GitCommitSummary[],
  logLimits: [] as Array<number | undefined>,
  vcs: { branch: "feat/x", default_branch: "main" } as { branch?: string; default_branch?: string },
  sessions: [] as Array<{ id: string; directory: string; workspaceId?: string; git?: { remote?: string } }>,
  projects: [] as Array<{ worktree: string; sandboxes?: string[]; workspaces?: Record<string, { id: string; workspaceId: string; directory: string; repo_url?: string }>; git?: { remote?: string } }>,
  stage: vi.fn(async (_paths: string[]) => undefined),
  unstage: vi.fn(async (_paths: string[]) => undefined),
  commitStaged: vi.fn(async (_input: { message: string; amend?: boolean }) => ({ commit: "abc" })),
  push: vi.fn(async (_input: { setUpstream?: boolean }) => ({ remote: "origin", branch: "feat/x" })),
  pending: undefined as undefined | [() => PendingAction, (next: PendingAction) => void],
  compare: {} as Record<string, Array<{ file: string; status?: string; additions: number; deletions: number }>>,
  compareRequests: [] as Array<{ mode: string; fromRef?: string; toRef?: string; content?: string }>,
  compareError: undefined as Error | undefined,
}))

vi.mock("@/platform/i18n/provider", async () => {
  const en = await vi.importActual<typeof import("@/platform/i18n/en")>("@/platform/i18n/en")
  const sourceControl = await vi.importActual<typeof import("@/platform/i18n/source-control/en")>(
    "@/platform/i18n/source-control/en",
  )
  const dict = new Map(Object.entries({ ...en.dict, ...sourceControl.dict }))
  return {
    useLanguage: () => ({
      intl: () => "en-US",
      t: (key: string, params?: Record<string, string | number>) =>
        (dict.get(key) ?? key).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => String(params?.[name] ?? "")),
    }),
  }
})

vi.mock("@/ui/semantic-icon", () => ({
  SemanticIcon: (props: { concept: string }) => <span data-testid="semantic-icon" data-concept={props.concept} />,
}))

vi.mock("@/ui/controls/claxedo-icon", () => ({
  ClaxedoIcon: (props: { name: string }) => <span data-icon={props.name} />,
}))

vi.mock("@opencode-ai/ui/dropdown-menu", () => {
  const Root = (props: { children: JSX.Element }) => <div data-testid="dropdown">{props.children}</div>
  const Trigger = (props: JSX.ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" {...props} />
  const Portal = (props: { children: JSX.Element }) => <>{props.children}</>
  const Content = (props: { children: JSX.Element }) => <div role="menu">{props.children}</div>
  const Item = (props: { children: JSX.Element; disabled?: boolean; onSelect?: () => void }) => (
    <button type="button" role="menuitem" disabled={props.disabled} onClick={() => props.onSelect?.()}>
      {props.children}
    </button>
  )
  const Separator = () => <hr />
  return { DropdownMenu: Object.assign(Root, { Trigger, Portal, Content, Item, Separator }) }
})

vi.mock("@/app/providers/sdk/sdk", () => ({
  useSDK: () => ({
    url: "http://opencode.test",
    directory: "/repo/main",
    workspaceId: "ws-1",
    client: {},
    git: {
      status: async () => {
        if (!h.status) return await new Promise<never>(() => undefined)
        return h.status
      },
      log: async (input?: { limit?: number }) => {
        h.logLimits.push(input?.limit)
        return { commits: h.commits }
      },
    },
    workspace: () => undefined,
  }),
}))

vi.mock("@/platform/runtime/workspace-query", () => ({
  workspaceVcsQuery: () => ({ queryKey: ["vcs", "/repo/main"], queryFn: async () => h.vcs }),
}))

vi.mock("@/app/workbench/context/workspace-git-mutations", () => ({
  useWorkspaceGitMutations: () => ({
    stage: h.stage,
    unstage: h.unstage,
    commitStaged: h.commitStaged,
    push: h.push,
    pending: () => h.pending?.[0]() ?? undefined,
  }),
}))

vi.mock("@/app/integrations/sync/query-options", () => ({
  useShellQueryOptions: () => ({ projects: () => ({ queryKey: ["projects"], queryFn: async () => h.projects }) }),
}))

vi.mock("@/features/session/data/sync/queries", () => ({
  sessionInventoryQueryOptions: () => ({ queryKey: ["inventory"], queryFn: async () => ({ sessions: h.sessions }) }),
  emptySessionInventory: () => ({ sessions: [] }),
}))

vi.mock("@/features/session/providers/session-params", () => ({
  useSessionParams: () => ({ directory: () => "/repo/main", sessionId: () => "ses-1" }),
}))

vi.mock("@/features/review/app-ports", async () => {
  const pane = await vi.importActual<typeof import("@/features/session/preferences/pane")>("@/features/session/preferences/pane")
  return { createPanePreferences: pane.createPanePreferences, reviewModePreferenceScope: pane.reviewModePreferenceScope }
})

vi.mock("@/platform/runtime/platform-provider", () => ({
  usePlatform: () => ({ fetch: globalThis.fetch }),
}))

vi.mock("@/features/review/ui/review-vcs-load", () => ({
  createReviewDiffClient: () => ({
    vcs: async (input: { mode: string; fromRef?: string; toRef?: string; content?: string }) => {
      h.compareRequests.push(input)
      if (h.compareError) throw h.compareError
      return h.compare[`${input.fromRef}..${input.toRef}`] ?? []
    },
  }),
}))

import { SourceControlView, type SourceControlReviewMode } from "./source-control-view"

const REVIEW_SCOPE = "session:ses-1"
const reviewSelection = () => createPanePreferences(localStorage).get("reviewMode", REVIEW_SCOPE)
const setReviewSelection = (selection?: ReviewSelection) => createPanePreferences(localStorage).set("reviewMode", REVIEW_SCOPE, selection)

const fixture = (): GitWorktreeStatus => ({
  branch: "feat/x",
  upstream: "origin/feat/x",
  ahead: 2,
  behind: 0,
  staged: [{ path: "src/a.ts", status: "added", additions: 10, deletions: 0 }],
  unstaged: [
    { path: "src/b.ts", status: "modified", additions: 3, deletions: 1 },
    { path: "README.md", status: "deleted", additions: 0, deletions: 5 },
    { path: "new.txt", status: "untracked", additions: 1, deletions: 0 },
  ],
})

const commitsFixture = (): GitCommitSummary[] => [
  {
    hash: "1111111111111111111111111111111111111111",
    shortHash: "1111111",
    subject: "feat: second",
    author: "Ada",
    date: new Date(Date.now() - 3_600_000).toISOString(),
    refs: ["HEAD -> feat/x", "origin/feat/x"],
    parents: ["2222222222222222222222222222222222222222"],
  },
  {
    hash: "2222222222222222222222222222222222222222",
    shortHash: "2222222",
    subject: "feat: first",
    author: "Bob",
    date: new Date(Date.now() - 86_400_000).toISOString(),
    refs: [],
    parents: [],
  },
]

const clients: QueryClient[] = []

function renderView(input: { onFileClick?: (path: string, mode: SourceControlReviewMode) => void; activePath?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return render(() => (
    <QueryClientProvider client={client}>
      <SourceControlView active activePath={input.activePath} onFileClick={input.onFileClick ?? (() => undefined)} />
    </QueryClientProvider>
  ))
}

const group = (id: "staged" | "changes" | "compare") => screen.getByTestId(`source-control-group-${id}`)
const rows = (id: "staged" | "changes" | "compare") =>
  within(screen.getByTestId(`source-control-section-${id}`)).getAllByTestId("source-control-row")
const row = (path: string) => screen.getAllByTestId("source-control-row").find((el) => el.getAttribute("data-path") === path)!
const message = (): HTMLTextAreaElement => screen.getByTestId("source-control-message")
const commitButton = (): HTMLButtonElement => screen.getByTestId("source-control-commit")
const menuItem = (label: string): HTMLButtonElement => screen.getByRole("menuitem", { name: label })

async function loaded() {
  await waitFor(() => expect(screen.queryByTestId("source-control-loading")).toBeNull())
}

const commitRow = (hash: string) => screen.getAllByTestId("source-control-commit-row").find((el) => el.getAttribute("data-hash") === hash)!
const expandGraph = () =>
  fireEvent.click(within(screen.getByTestId("source-control-group-graph")).getByRole("button", { expanded: false }))

beforeEach(() => {
  setReviewSelection(undefined)
  h.compare = {}
  h.compareRequests = []
  h.compareError = undefined
  h.status = fixture()
  h.commits = commitsFixture()
  h.logLimits = []
  h.vcs = { branch: "feat/x", default_branch: "main" }
  h.sessions = []
  h.projects = []
  h.pending = createSignal<PendingAction>(undefined)
  h.stage.mockClear()
  h.unstage.mockClear()
  h.commitStaged.mockClear()
  h.commitStaged.mockImplementation(async () => ({ commit: "abc" }))
  h.push.mockClear()
  h.push.mockImplementation(async () => ({ remote: "origin", branch: "feat/x" }))
})

afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
})

describe("SourceControlView groups", () => {
  test("renders the staged and unstaged groups with counts, status letters, and dimmed directories", async () => {
    renderView()
    await loaded()

    expect(group("staged").getAttribute("data-count")).toBe("1")
    expect(group("changes").getAttribute("data-count")).toBe("3")
    expect(rows("staged").map((el) => el.getAttribute("data-path"))).toEqual(["src/a.ts"])
    expect(rows("changes").map((el) => el.getAttribute("data-path"))).toEqual(["src/b.ts", "README.md", "new.txt"])
    expect(rows("changes").map((el) => el.getAttribute("data-status"))).toEqual(["modified", "deleted", "untracked"])
    expect(row("src/a.ts").textContent).toContain("A")
    expect(row("src/b.ts").textContent).toContain("M")
    expect(row("README.md").textContent).toContain("D")
    expect(row("new.txt").textContent).toContain("U")
    expect(within(row("src/b.ts")).getByText("src")).toBeTruthy()
    expect(within(row("src/b.ts")).getByText("+3")).toBeTruthy()
    expect(within(row("src/b.ts")).getByText("-1")).toBeTruthy()
    expect(screen.queryByTestId("source-control-empty")).toBeNull()
  })

  test("shows skeleton rows while the status is pending and 'No changes' once both groups are empty", async () => {
    h.status = undefined
    renderView()
    expect(screen.getByTestId("source-control-loading")).toBeTruthy()
    cleanup()

    h.status = { ...fixture(), staged: [], unstaged: [] }
    renderView()
    await loaded()
    expect(screen.getByTestId("source-control-empty").textContent).toBe("No changes")
    expect(group("staged").getAttribute("data-count")).toBe("0")
  })

  test("a group header collapses and re-expands its rows", async () => {
    renderView()
    await loaded()
    const toggle = within(group("changes")).getByRole("button", { expanded: true })
    fireEvent.click(toggle)
    expect(group("changes").getAttribute("data-collapsed")).toBe("true")
    expect(screen.queryAllByTestId("source-control-row").map((el) => el.getAttribute("data-path"))).toEqual(["src/a.ts"])
    fireEvent.click(within(group("changes")).getByRole("button", { expanded: false }))
    expect(screen.getAllByTestId("source-control-row")).toHaveLength(4)
  })

  test("highlights the active path", async () => {
    renderView({ activePath: "src/b.ts" })
    await loaded()
    expect(row("src/b.ts").classList.contains("bg-surface-base-active")).toBe(true)
    expect(row("src/a.ts").classList.contains("bg-surface-base-active")).toBe(false)
  })
})

describe("SourceControlView stage and unstage", () => {
  test("Stage on a row stages that path; Stage all stages every unstaged path", async () => {
    renderView()
    await loaded()

    fireEvent.click(within(row("src/b.ts")).getByRole("button", { name: "Stage src/b.ts" }))
    expect(h.stage).toHaveBeenCalledWith(["src/b.ts"])

    fireEvent.click(within(group("changes")).getByRole("button", { name: "Stage all" }))
    expect(h.stage).toHaveBeenLastCalledWith(["src/b.ts", "README.md", "new.txt"])
    expect(h.unstage).not.toHaveBeenCalled()
  })

  test("Unstage on a row unstages that path; Unstage all unstages every staged path", async () => {
    h.status = { ...fixture(), staged: [...fixture().staged, { path: "lib/c.ts", status: "renamed", additions: 0, deletions: 0, from: "lib/old.ts" }] }
    renderView()
    await loaded()

    fireEvent.click(within(row("src/a.ts")).getByRole("button", { name: "Unstage src/a.ts" }))
    expect(h.unstage).toHaveBeenCalledWith(["src/a.ts"])

    fireEvent.click(within(group("staged")).getByRole("button", { name: "Unstage all" }))
    expect(h.unstage).toHaveBeenLastCalledWith(["src/a.ts", "lib/c.ts"])
    expect(h.stage).not.toHaveBeenCalled()
  })

  test("a row click reports the path with the group's review mode", async () => {
    const onFileClick = vi.fn()
    renderView({ onFileClick })
    await loaded()

    fireEvent.click(within(row("src/a.ts")).getByText("a.ts"))
    expect(onFileClick).toHaveBeenLastCalledWith("src/a.ts", "staged")
    fireEvent.click(within(row("README.md")).getByText("README.md"))
    expect(onFileClick).toHaveBeenLastCalledWith("README.md", "unstaged")
  })
})

describe("SourceControlView commit box", () => {
  test("Commit is disabled without a message or without staged files, and enabled with both", async () => {
    renderView()
    await loaded()
    expect(commitButton().disabled).toBe(true)

    fireEvent.input(message(), { target: { value: "   " } })
    expect(commitButton().disabled).toBe(true)

    fireEvent.input(message(), { target: { value: "feat: thing" } })
    expect(commitButton().disabled).toBe(false)
    cleanup()

    h.status = { ...fixture(), staged: [] }
    renderView()
    await loaded()
    fireEvent.input(message(), { target: { value: "feat: thing" } })
    expect(commitButton().disabled).toBe(true)
    expect(menuItem("Commit & Push").disabled).toBe(true)
    expect(menuItem("Amend last commit").disabled).toBe(false)
  })

  test("Commit calls commitStaged with the trimmed message and clears the box", async () => {
    renderView()
    await loaded()
    fireEvent.input(message(), { target: { value: "  feat: thing\n\nbody  " } })
    expect(message().rows).toBe(3)

    fireEvent.click(commitButton())
    expect(h.commitStaged).toHaveBeenCalledWith({ message: "feat: thing\n\nbody", amend: false })
    await waitFor(() => expect(message().value).toBe(""))
    expect(message().rows).toBe(1)
    expect(h.push).not.toHaveBeenCalled()
  })

  test("the message box grows to at most six rows", async () => {
    renderView()
    await loaded()
    fireEvent.input(message(), { target: { value: "1\n2\n3\n4\n5\n6\n7\n8" } })
    expect(message().rows).toBe(6)
  })

  test("⌘⏎ and Ctrl+⏎ commit when Commit is enabled and do nothing otherwise", async () => {
    renderView()
    await loaded()
    fireEvent.keyDown(message(), { key: "Enter", metaKey: true })
    expect(h.commitStaged).not.toHaveBeenCalled()

    fireEvent.input(message(), { target: { value: "feat: keyboard" } })
    fireEvent.keyDown(message(), { key: "Enter" })
    expect(h.commitStaged).not.toHaveBeenCalled()
    fireEvent.keyDown(message(), { key: "Enter", metaKey: true })
    expect(h.commitStaged).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(message().value).toBe(""))

    fireEvent.input(message(), { target: { value: "feat: ctrl" } })
    fireEvent.keyDown(message(), { key: "Enter", ctrlKey: true })
    expect(h.commitStaged).toHaveBeenCalledTimes(2)
    expect(h.commitStaged).toHaveBeenLastCalledWith({ message: "feat: ctrl", amend: false })
  })

  test("Commit & Push commits, then pushes", async () => {
    renderView()
    await loaded()
    fireEvent.input(message(), { target: { value: "feat: ship" } })

    fireEvent.click(menuItem("Commit & Push"))
    await waitFor(() => expect(h.push).toHaveBeenCalledWith({}))
    expect(h.commitStaged).toHaveBeenCalledWith({ message: "feat: ship", amend: false })
    expect(h.commitStaged.mock.invocationCallOrder[0]).toBeLessThan(h.push.mock.invocationCallOrder[0])
    await waitFor(() => expect(message().value).toBe(""))
  })

  test("Amend last commit commits with amend: true even with nothing staged", async () => {
    h.status = { ...fixture(), staged: [] }
    renderView()
    await loaded()
    fireEvent.input(message(), { target: { value: "fix: typo" } })

    fireEvent.click(menuItem("Amend last commit"))
    expect(h.commitStaged).toHaveBeenCalledWith({ message: "fix: typo", amend: true })
    await waitFor(() => expect(message().value).toBe(""))
  })

  test("a failed commit keeps the message and shows the coded error inline", async () => {
    h.commitStaged.mockImplementation(async () => {
      throw new WorkspaceGitError("git_nothing_staged", 400, "nothing to commit")
    })
    renderView()
    await loaded()
    fireEvent.input(message(), { target: { value: "feat: doomed" } })
    fireEvent.click(commitButton())

    await waitFor(() => expect(screen.getByTestId("source-control-error").textContent).toBe("Nothing is staged."))
    expect(message().value).toBe("feat: doomed")
    expect(message().getAttribute("aria-invalid")).toBe("true")

    fireEvent.input(message(), { target: { value: "feat: retry" } })
    h.commitStaged.mockImplementation(async () => ({ commit: "abc" }))
    fireEvent.click(commitButton())
    await waitFor(() => expect(screen.queryByTestId("source-control-error")).toBeNull())
  })
})

describe("SourceControlView actions row", () => {
  test("Publish Branch shows without an upstream and pushes with setUpstream", async () => {
    h.status = { ...fixture(), upstream: undefined, ahead: 0 }
    renderView()
    await loaded()
    expect(screen.queryByTestId("source-control-push")).toBeNull()
    expect(screen.queryByTestId("source-control-up-to-date")).toBeNull()

    fireEvent.click(screen.getByTestId("source-control-publish"))
    expect(h.push).toHaveBeenCalledWith({ setUpstream: true })
  })

  test("Push shows with the ahead count when ahead > 0 and pushes plainly", async () => {
    renderView()
    await loaded()
    expect(screen.queryByTestId("source-control-publish")).toBeNull()
    const push = screen.getByTestId("source-control-push")
    expect(push.textContent).toContain("Push 2")

    fireEvent.click(push)
    expect(h.push).toHaveBeenCalledWith({})
  })

  test("Up to date shows with an upstream and nothing ahead", async () => {
    h.status = { ...fixture(), ahead: 0 }
    renderView()
    await loaded()
    expect(screen.getByTestId("source-control-up-to-date").textContent).toBe("Up to date")
    expect(screen.queryByTestId("source-control-push")).toBeNull()
    expect(screen.queryByTestId("source-control-publish")).toBeNull()
  })

  test("a rejected push shows the git stderr inline", async () => {
    h.push.mockImplementation(async () => {
      throw new WorkspaceGitError("git_push_rejected", 502, "! [rejected] feat/x -> feat/x (non-fast-forward)")
    })
    renderView()
    await loaded()
    fireEvent.click(screen.getByTestId("source-control-push"))
    await waitFor(() =>
      expect(screen.getByTestId("source-control-error").textContent).toBe(
        "Push rejected: ! [rejected] feat/x -> feat/x (non-fast-forward)",
      ),
    )
  })

  test("Create PR is hidden without a GitHub remote", async () => {
    h.sessions = [{ id: "s1", directory: "/repo/main", git: { remote: "git@gitlab.com:acme/app.git" } }]
    renderView()
    await loaded()
    await waitFor(() => expect(screen.getByTestId("source-control-push")).toBeTruthy())
    expect(screen.queryByTestId("source-control-create-pr")).toBeNull()
  })

  test("Create PR links to the GitHub compare URL from the session inventory's remote", async () => {
    h.sessions = [{ id: "s1", directory: "/repo/main", git: { remote: "git@github.com:acme/app.git" } }]
    renderView()
    await loaded()
    const link = await screen.findByTestId("source-control-create-pr")
    expect(link.getAttribute("href")).toBe("https://github.com/acme/app/compare/main...feat%2Fx?expand=1")
    expect(link.getAttribute("target")).toBe("_blank")
    expect(link.getAttribute("rel")).toBe("noopener noreferrer")
  })

  test("Create PR falls back to the workspace catalog's repo_url and hides on the default branch", async () => {
    h.projects = [
      {
        worktree: "/repo/main",
        workspaces: { "/repo/main": { id: "ws-1", workspaceId: "ws-1", directory: "/repo/main", repo_url: "https://github.com/acme/app" } },
      },
    ]
    renderView()
    await loaded()
    const link = await screen.findByTestId("source-control-create-pr")
    expect(link.getAttribute("href")).toBe("https://github.com/acme/app/compare/main...feat%2Fx?expand=1")
    cleanup()

    h.status = { ...fixture(), branch: "main" }
    h.vcs = { branch: "main", default_branch: "main" }
    renderView()
    await loaded()
    await waitFor(() => expect(screen.getByTestId("source-control-push")).toBeTruthy())
    expect(screen.queryByTestId("source-control-create-pr")).toBeNull()
  })
})

describe("SourceControlView graph", () => {
  test("renders one row per commit with hash, subject, ref chips, author, and relative time", async () => {
    renderView()
    await loaded()
    expandGraph()
    const graph = screen.getByTestId("source-control-graph")
    const items = within(graph).getAllByTestId("source-control-commit-row")
    expect(items.map((el) => el.getAttribute("data-hash"))).toEqual([
      "1111111111111111111111111111111111111111",
      "2222222222222222222222222222222222222222",
    ])
    expect(h.logLimits).toEqual([50])
    expect(within(items[0]).getByText("feat: second")).toBeTruthy()
    expect(within(items[0]).getByText("1111111")).toBeTruthy()
    expect(within(items[0]).getByText("HEAD -> feat/x")).toBeTruthy()
    expect(within(items[0]).getByText("origin/feat/x")).toBeTruthy()
    expect(within(items[0]).getByText("Ada")).toBeTruthy()
    expect(within(items[0]).getByText("1 hour ago")).toBeTruthy()
    expect(within(items[1]).getByText("1 day ago")).toBeTruthy()
  })

  test("the Graph starts collapsed at the bottom under the groups; expanded, it shares the column", async () => {
    renderView()
    await loaded()
    const column = screen.getByTestId("source-control-groups").parentElement!
    const groups = screen.getByTestId("source-control-groups")
    const graph = screen.getByTestId("source-control-graph")
    expect(screen.getByTestId("source-control-group-graph").getAttribute("data-collapsed")).toBe("true")
    expect(column.lastElementChild).toBe(graph)
    expect(graph.classList.contains("shrink-0")).toBe(true)
    expect(graph.classList.contains("flex-1")).toBe(false)
    expect(groups.classList.contains("flex-1")).toBe(true)
    expect(groups.classList.contains("max-h-[65%]")).toBe(false)
    expect(within(graph).queryAllByTestId("source-control-commit-row")).toHaveLength(0)

    fireEvent.click(within(screen.getByTestId("source-control-group-graph")).getByRole("button", { expanded: false }))
    expect(screen.getByTestId("source-control-group-graph").getAttribute("data-collapsed")).toBeNull()
    expect(column.lastElementChild).toBe(graph)
    expect(graph.classList.contains("flex-1")).toBe(true)
    expect(groups.classList.contains("max-h-[65%]")).toBe(true)
    expect(groups.classList.contains("flex-1")).toBe(false)
    expect(within(graph).getAllByTestId("source-control-commit-row")).toHaveLength(2)
  })

  test("the expanded graph shows 'No commits' when the log is empty", async () => {
    h.commits = []
    renderView()
    await loaded()
    expandGraph()
    await waitFor(() => expect(within(screen.getByTestId("source-control-graph")).getByText("No commits")).toBeTruthy())
    fireEvent.click(within(screen.getByTestId("source-control-group-graph")).getByRole("button"))
    expect(within(screen.getByTestId("source-control-graph")).queryByText("No commits")).toBeNull()
  })

  test("clicking a commit compares it against its first parent, selects the row, and lists its files", async () => {
    h.compare["2222222222222222222222222222222222222222..1111111111111111111111111111111111111111"] = [
      { file: "src/second.ts", status: "added", additions: 4, deletions: 0 },
      { file: "src/a.ts", status: "modified", additions: 1, deletions: 2 },
    ]
    const onFileClick = vi.fn()
    renderView({ onFileClick })
    await loaded()
    expandGraph()
    expect(screen.queryByTestId("source-control-group-compare")).toBeNull()

    fireEvent.click(commitRow("1111111111111111111111111111111111111111"))
    expect(reviewSelection()).toEqual({
      mode: "to-from",
      fromRef: "2222222222222222222222222222222222222222",
      toRef: "1111111111111111111111111111111111111111",
    })
    const row = commitRow("1111111111111111111111111111111111111111")
    expect(row.getAttribute("aria-selected")).toBe("true")
    expect(row.classList.contains("bg-surface-base-active")).toBe(true)
    expect(commitRow("2222222222222222222222222222222222222222").getAttribute("aria-selected")).toBe("false")

    await waitFor(() => expect(group("compare").getAttribute("data-count")).toBe("2"))
    expect(group("compare").getAttribute("data-active")).toBe("true")
    expect(within(group("compare")).getByText("2222222 → 1111111")).toBeTruthy()
    expect(screen.getByTestId("source-control-groups").firstElementChild).toBe(screen.getByTestId("source-control-section-compare"))
    expect(rows("compare").map((el) => el.getAttribute("data-path"))).toEqual(["src/second.ts", "src/a.ts"])
    expect(rows("compare").map((el) => el.getAttribute("data-status"))).toEqual(["added", "modified"])
    expect(rows("compare").map((el) => el.getAttribute("data-group"))).toEqual(["compare", "compare"])
    expect(within(rows("compare")[1]).getByText("+1")).toBeTruthy()
    expect(within(rows("compare")[1]).getByText("-2")).toBeTruthy()
    expect(h.compareRequests).toEqual([
      {
        directory: "/repo/main",
        mode: "to-from",
        fromRef: "2222222222222222222222222222222222222222",
        toRef: "1111111111111111111111111111111111111111",
        content: "summary",
      },
    ])

    fireEvent.click(within(rows("compare")[0]).getByText("second.ts"))
    expect(onFileClick).toHaveBeenLastCalledWith("src/second.ts", "to-from")
    expect(rows("compare")[0].classList.contains("bg-surface-base-active")).toBe(true)

    fireEvent.click(commitRow("1111111111111111111111111111111111111111"))
    expect(reviewSelection()).toEqual({ mode: "uncommitted" })
    expect(commitRow("1111111111111111111111111111111111111111").getAttribute("aria-selected")).toBe("false")
    expect(screen.queryByTestId("source-control-group-compare")).toBeNull()
  })

  test("a branch mode lists the files since the base, labelled by what it runs up to, and opens them in that mode", async () => {
    h.compare["main..undefined"] = [{ file: "src/branch.ts", status: "added", additions: 3, deletions: 0 }]
    setReviewSelection({ mode: "branch", fromRef: "main" })
    const onFileClick = vi.fn()
    renderView({ onFileClick })
    await loaded()

    await waitFor(() => expect(group("compare").getAttribute("data-count")).toBe("1"))
    expect(within(group("compare")).getByText("main → feat/x")).toBeTruthy()
    expect(h.compareRequests).toEqual([{ directory: "/repo/main", mode: "branch", fromRef: "main", content: "summary" }])
    fireEvent.click(within(rows("compare")[0]).getByText("branch.ts"))
    expect(onFileClick).toHaveBeenLastCalledWith("src/branch.ts", "branch")

    setReviewSelection({ mode: "branch-worktree", fromRef: "main" })
    await waitFor(() => expect(within(group("compare")).getByText("main → working tree")).toBeTruthy())
    expect(h.compareRequests.at(-1)).toEqual({ directory: "/repo/main", mode: "branch-worktree", fromRef: "main", content: "summary" })
    await waitFor(() => expect(rows("compare")).toHaveLength(1))
    fireEvent.click(within(rows("compare")[0]).getByText("branch.ts"))
    expect(onFileClick).toHaveBeenLastCalledWith("src/branch.ts", "branch-worktree")
  })

  test("a root commit compares against the empty tree", async () => {
    renderView()
    await loaded()
    expandGraph()
    fireEvent.click(commitRow("2222222222222222222222222222222222222222"))
    expect(reviewSelection()).toEqual({
      mode: "to-from",
      fromRef: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      toRef: "2222222222222222222222222222222222222222",
    })
    await waitFor(() => expect(within(group("compare")).getByText("4b825dc → 2222222")).toBeTruthy())
  })
})

describe("SourceControlView compare selection", () => {
  test("a persisted branch comparison lists its files under the branch → head label and no commit is selected", async () => {
    h.compare["main..HEAD"] = [{ file: "src/b.ts", status: "modified", additions: 3, deletions: 1 }]
    setReviewSelection({ mode: "to-from", fromRef: "main", toRef: "HEAD" })
    renderView()
    await loaded()
    await waitFor(() => expect(group("compare").getAttribute("data-count")).toBe("1"))
    expect(within(group("compare")).getByText("main → feat/x")).toBeTruthy()
    expect(within(group("compare")).getByTitle("Compared changes")).toBeTruthy()
    expect(rows("compare").map((el) => el.getAttribute("data-path"))).toEqual(["src/b.ts"])
    expandGraph()
    expect(screen.getAllByTestId("source-control-commit-row").every((el) => el.getAttribute("aria-selected") === "false")).toBe(true)
    expect(group("staged").getAttribute("data-active")).toBeNull()
    expect(group("changes").getAttribute("data-active")).toBeNull()
  })

  test("the empty comparison says No changes and the compare group collapses on its own", async () => {
    setReviewSelection({ mode: "to-from", fromRef: "main", toRef: "HEAD" })
    renderView()
    await loaded()
    await waitFor(() => expect(screen.getByTestId("source-control-compare-empty").textContent).toBe("No changes"))
    fireEvent.click(within(group("compare")).getByRole("button", { expanded: true }))
    expect(group("compare").getAttribute("data-collapsed")).toBe("true")
    expect(screen.queryByTestId("source-control-compare-empty")).toBeNull()
    expect(rows("staged")).toHaveLength(1)
  })

  test("a comparison whose ref no longer resolves shows the git error instead of No changes", async () => {
    h.compareError = new Error("fatal: bad revision 'deadbeef'")
    setReviewSelection({ mode: "to-from", fromRef: "deadbeef", toRef: "HEAD" })
    renderView()
    await loaded()
    await waitFor(() => expect(screen.getByTestId("source-control-compare-error").textContent).toBe("fatal: bad revision 'deadbeef'"))
    expect(screen.queryByTestId("source-control-compare-empty")).toBeNull()
    expect(within(group("compare").parentElement!).queryAllByTestId("source-control-row")).toHaveLength(0)
    expect(rows("staged")).toHaveLength(1)
  })

  test("the staged or unstaged review mode quietly highlights its group header", async () => {
    setReviewSelection({ mode: "staged" })
    renderView()
    await loaded()
    expect(group("staged").getAttribute("data-active")).toBe("true")
    expect(within(group("staged")).getByRole("button", { expanded: true }).classList.contains("text-text-base")).toBe(true)
    expect(group("changes").getAttribute("data-active")).toBeNull()
    expect(within(group("changes")).getByRole("button", { expanded: true }).classList.contains("text-text-weaker")).toBe(true)
    expect(screen.queryByTestId("source-control-group-compare")).toBeNull()

    setReviewSelection({ mode: "unstaged" })
    expect(group("staged").getAttribute("data-active")).toBeNull()
    expect(group("changes").getAttribute("data-active")).toBe("true")
  })
})

describe("SourceControlView pending", () => {
  test("the view is inert while a mutation is pending and the in-flight action shows its spinner", async () => {
    renderView()
    await loaded()
    const view = screen.getByTestId("source-control-view")
    expect(view.getAttribute("aria-busy")).toBeNull()

    h.pending![1]("push")
    expect(view.getAttribute("aria-busy")).toBe("true")
    expect(view.classList.contains("claxedo-source-control--busy")).toBe(true)
    expect(within(screen.getByTestId("source-control-push")).queryByTestId("semantic-icon")).toBeNull()
    expect(screen.getByTestId("source-control-push").querySelector("[data-component=spinner]")).toBeTruthy()
    expect(commitButton().querySelector("[data-component=spinner]")).toBeNull()

    h.pending![1]("commit")
    expect(commitButton().querySelector("[data-component=spinner]")).toBeTruthy()

    h.pending![1](undefined)
    expect(view.getAttribute("aria-busy")).toBeNull()
  })
})
