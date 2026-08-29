import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { MemoryRouter, Route } from "@solidjs/router"
import { createComputed, createRoot, type JSX } from "solid-js"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { ClaxedoStateProvider } from "../state/index"
import { emptyClaxedoState } from "../state/persistence"
import { RailSidebar, type ProjectItem } from "./rail-sidebar"
import { SessionTitleProjectionProvider } from "@/features/session/providers/session-title-projection-provider"
import type { SessionNavigationDisplayRow } from "../../../features/session/ui/navigation/session-navigation-list"

vi.mock("@claxedo/app", () => ({
  getAvatarColors: () => ({ background: "#000", color: "#fff" }),
  useLanguage: () => ({ t: (key: string) => key }),
  usePlatform: () => ({ platform: "web" }),
  useServer: () => ({ isLocal: () => true }),
}))

// `useLanguage` lives in `@/platform/i18n/provider` now, not `@claxedo/app`.
// (The older `rail-sidebar-disclosure.vitest.tsx` still mocks the old location,
// which is why every test in that file currently fails to render the sidebar.)
vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({
    ready: () => true,
    locale: () => "en",
    intl: () => ({}),
    locales: ["en"],
    label: (value: string) => value,
    t: (key: string) => key,
    setLocale: () => undefined,
  }),
}))

vi.mock("@/app/connection/server", () => ({
  useServer: () => ({ isLocal: () => true, current: undefined }),
}))

vi.mock("@/platform/account/account-provider", () => ({
  useAccountPort: () => ({
    state: () => ({ status: "signed-out" }),
    signIn: async () => undefined,
    signOut: async () => undefined,
    run: async () => undefined,
  }),
  AccountPortProvider: (props: { children: unknown }) => props.children,
}))

const sdkClient = () => ({
  session: {
    status: vi.fn(async () => ({})),
    requests: vi.fn(async () => ({})),
    list: vi.fn(async () => ({ data: [] })),
  },
  permission: { list: vi.fn(async () => ({ data: [] })) },
  question: { list: vi.fn(async () => ({ data: [] })) },
})

vi.mock("@/app/providers/global-sdk/provider", () => ({
  useGlobalSDK: () => ({
    url: "http://localhost:4096",
    // Every method resolves: advancing the fake clock runs the rail's status
    // poll, and a bare vi.fn() returning undefined breaks its `.then`.
    createClient: () => sdkClient(),
    client: sdkClient(),
  }),
}))

vi.mock("@/features/terminal/providers/provider", () => ({
  useOptionalTerminal: () => ({ all: () => [], close: vi.fn() }),
}))

vi.mock("@/features/session/providers/permission", () => ({
  usePermission: () => ({ autoResponds: () => false }),
}))

vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({ show: vi.fn(), close: vi.fn() }),
}))

vi.mock("../../../features/workspaces/data/workspace-connection", () => ({
  workspacePlacement: () => undefined,
  isWorkspaceReady: () => true,
}))

vi.mock("../../../features/settings/ui/terminals", () => ({
  getTerminalCommands: () => ({ claude: "claude", codex: "codex", custom: [] }),
}))

vi.mock("../../../features/session/data/sync/session-inventory", () => ({
  useSessionInventoryActions: () => ({
    load: vi.fn(),
    reloadWorkspace: vi.fn(),
    loadMoreProject: vi.fn(),
    loadMoreWorkspace: vi.fn(),
  }),
}))

// A session old enough that its rendered label ("2d") is STABLE across a tick.
// That is the case the fix is about: the row is rebuilt every 10 s to produce a
// label that cannot have changed.
const SESSION_UPDATED_AT = Date.now() - 2 * 24 * 60 * 60 * 1000

vi.mock("../../../features/session/data/query/session-list", () => ({
  sessionListQueryOptions: (input: { query?: { scope?: string } }) => ({
    queryKey: ["test-session-list", input.query?.scope ?? "unknown"],
    queryFn: async () => ({
      view: { scope: input.query?.scope ?? "workspace", groupBy: "none", sort: "updated_desc", limit: 25 },
      items: [{
        type: "session",
        sessionRef: "ses_lazy",
        sessionId: "ses_lazy",
        title: "Lazy label session",
        directory: "/repo/main",
        createdAt: SESSION_UPDATED_AT,
        updatedAt: SESSION_UPDATED_AT,
        tags: [],
        attachments: [],
      }],
      totalKnown: 1,
    }),
    initialData: {
      view: { scope: input.query?.scope ?? "workspace", groupBy: "none", sort: "updated_desc", limit: 25 },
      items: [{
        type: "session",
        sessionRef: "ses_lazy",
        sessionId: "ses_lazy",
        title: "Lazy label session",
        directory: "/repo/main",
        createdAt: SESSION_UPDATED_AT,
        updatedAt: SESSION_UPDATED_AT,
        tags: [],
        attachments: [],
      }],
      totalKnown: 1,
    },
  }),
  appendSessionListPageQueryData: () => undefined,
}))

// Capture the display rows the rail hands to the navigation list. Mocking the
// child is the only seam that yields a REAL row object built by the real
// `sessionDisplayRow`, without restructuring production code to expose it.
const captured: SessionNavigationDisplayRow[][] = []
vi.mock("../../../features/session/ui/navigation/session-navigation-list", () => ({
  SessionNavigation: (props: { rows: readonly SessionNavigationDisplayRow[] }) => {
    captured.push([...props.rows])
    return null
  },
}))

beforeEach(() => {
  // Installed before render so the rail's own 10 s setInterval is a fake timer.
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  localStorage.clear()
  captured.length = 0
})

const project = {
  id: "project-1",
  worktree: "/repo/main",
  name: "Main",
  workspaces: {
    "/repo/main": { id: "/repo/main", directory: "/repo/main", kind: "local" },
  },
} satisfies ProjectItem

function renderInRouter(component: () => JSX.Element) {
  return render(() => (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <Route path="*" component={component} />
      </MemoryRouter>
    </QueryClientProvider>
  ))
}

async function renderSidebarWithSession() {
  localStorage.setItem("claxedo.session-view.v1", JSON.stringify({
    group: "project", status: [], environment: [], git: [], archived: "active",
  }))
  renderInRouter(() => (
    <SessionTitleProjectionProvider>
      <ClaxedoStateProvider initialState={emptyClaxedoState()}>
        <RailSidebar
        projects={[project]}
        onRailCancelCollapse={() => undefined}
        onRailLockChange={() => undefined}
        onRailMouseLeave={() => undefined}
        onRailTrackPosition={() => undefined}
        onToggleSidebar={() => undefined}
        railDocked
        railExpanded
        railWidth={260}
        />
      </ClaxedoStateProvider>
    </SessionTitleProjectionProvider>
  ))
  fireEvent.click(screen.getByRole("button", { name: "Expand project" }))
  // Let the mocked session-list query resolve and the section re-render. Fake
  // timers are already installed (the rail's 10 s interval must be one of
  // them), so drive the wait through them rather than a real sleep.
  for (let i = 0; i < 40 && !captured.some((rows) => rows.length > 0); i++) {
    await vi.advanceTimersByTimeAsync(10)
  }
  const rows = [...captured].reverse().find((entry) => entry.length > 0)
  if (!rows?.[0]) throw new Error("no session display row was produced")
  return rows[0]
}

describe("rail session row clock invalidation", () => {
  test("timeLabel is a lazy accessor, not a precomputed value", async () => {
    const row = await renderSidebarWithSession()

    const descriptor = Object.getOwnPropertyDescriptor(row, "timeLabel")
    expect(typeof descriptor?.get).toBe("function")
    expect(descriptor?.value).toBeUndefined()
    expect(row.timeLabel).toBe("2d")
  })

  test("active is a lazy accessor, not a precomputed value", async () => {
    const row = await renderSidebarWithSession()

    // Same contract as `timeLabel`: the focused workbench surface is a
    // broadcast signal that changes on every session switch. If `active` is
    // computed while BUILDING the row, every switch rebuilds every row object
    // in every section. The accessor keeps the row referentially stable so
    // only the two affected rows' bindings re-run.
    const descriptor = Object.getOwnPropertyDescriptor(row, "active")
    expect(typeof descriptor?.get).toBe("function")
    expect(descriptor?.value).toBeUndefined()
    expect(row.active).toBe(false)
  })

  test("title is a lazy accessor, not an array-wide projection read", async () => {
    const row = await renderSidebarWithSession()

    const descriptor = Object.getOwnPropertyDescriptor(row, "title")
    expect(typeof descriptor?.get).toBe("function")
    expect(descriptor?.value).toBeUndefined()
    expect(row.title).toBe("Lazy label session")
  })

  test("a clock tick re-runs the timeLabel binding and nothing else on the row", async () => {
    {
      const row = await renderSidebarWithSession()

      let labelRuns = 0
      let titleRuns = 0
      const dispose = createRoot((disposeRoot) => {
        createComputed(() => { row.timeLabel; labelRuns++ })
        createComputed(() => { row.title; titleRuns++ })
        return disposeRoot
      })

      expect(labelRuns).toBe(1)
      expect(titleRuns).toBe(1)

      // one 10 s rail clock tick
      await vi.advanceTimersByTimeAsync(10_000)

      // The label binding re-ran because the clock read lives in its accessor...
      expect(labelRuns).toBe(2)
      // ...and the other derived fields did not, because building the row no
      // longer reads the clock. If `clock()` moves back to the top of
      // `sessionDisplayRow`, `timeLabel` becomes a plain string, this row object
      // is replaced instead of updated, and labelRuns stays at 1 — failing above.
      expect(titleRuns).toBe(1)

      dispose()
    }
  })
})
