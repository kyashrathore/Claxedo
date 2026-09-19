import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { MemoryRouter, Route } from "@solidjs/router"
import type { JSX } from "solid-js"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { ClaxedoStateProvider, useClaxedoState } from "../state/index"
import { emptyClaxedoState } from "../state/persistence"
import { RailSidebar, type ProjectItem } from "./rail-sidebar"
import { SessionTitleProjectionProvider } from "@/features/session/providers/session-title-projection-provider"
import { sessionRefForWorkspaceSession } from "@/platform/identity/session-ref"
import type {
  SessionNavigationDisplayRow,
  SessionNavigationProps,
} from "../../../features/session/ui/navigation/session-navigation-list"

vi.mock("@claxedo/app", () => ({
  getAvatarColors: () => ({ background: "#000", color: "#fff" }),
  useLanguage: () => ({ t: (key: string) => key }),
  usePlatform: () => ({ platform: "web" }),
  useServer: () => ({ isLocal: () => true }),
}))

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
    state: () => ({ status: "unsigned" }),
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
  workspaceRelayPlacement: () => undefined,
  isWorkspaceReady: () => true,
}))

vi.mock("@/features/terminal/core/terminal-commands", () => ({
  getTerminalCommands: () => ({ agents: { claude: "claude", codex: "codex", cursor: "cursor-agent", gemini: "gemini" }, custom: [] }),
}))

vi.mock("../../../features/session/data/sync/session-inventory", () => ({
  useSessionInventoryActions: () => ({
    load: vi.fn(),
    reloadWorkspace: vi.fn(),
    loadMoreProject: vi.fn(),
    loadMoreWorkspace: vi.fn(),
  }),
}))

const WORKSPACE_ID = "ws_host"
const WORKSPACE_REF = `workspace:${WORKSPACE_ID}`
const SESSION_ID = "ses_host"
const SESSION_UPDATED_AT = Date.now() - 60_000

// A session read from a user-hosted workspace's own runtime: `sessionRowDirectory`
// addresses it as `workspace:<id>`, never as the host's filesystem path.
const HOST_SESSION_ROW = {
  type: "session",
  sessionRef: `${WORKSPACE_REF}:session:${SESSION_ID}`,
  sessionId: SESSION_ID,
  title: "session on the host",
  directory: WORKSPACE_REF,
  workspaceId: WORKSPACE_ID,
  createdAt: SESSION_UPDATED_AT,
  updatedAt: SESSION_UPDATED_AT,
  tags: [],
  attachments: [],
}

const HOST_SESSION_PAGE = {
  view: { scope: "project", groupBy: "none", sort: "updated_desc", limit: 25 },
  items: [HOST_SESSION_ROW],
  totalKnown: 1,
}

vi.mock("../../../features/session/data/sync/session-source", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../features/session/data/sync/session-source")>()),
  sessionSourceQueryOptions: (input: { query?: { scope?: string } }) => ({
    queryKey: ["test-session-list", input.query?.scope ?? "unknown"],
    queryFn: async () => HOST_SESSION_PAGE,
    initialData: HOST_SESSION_PAGE,
  }),
}))

const captured: SessionNavigationDisplayRow[][] = []
const capturedActivations: SessionNavigationProps["onActivate"][] = []
vi.mock("../../../features/session/ui/navigation/session-navigation-list", () => ({
  SessionNavigation: (props: SessionNavigationProps) => {
    captured.push([...props.rows])
    capturedActivations.push(props.onActivate)
    return null
  },
}))

let workbench: ReturnType<typeof useClaxedoState> | undefined
function WorkbenchProbe() {
  workbench = useClaxedoState()
  return null
}

beforeEach(() => {
  vi.useFakeTimers()
  window.history.replaceState(null, "", "/")
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  localStorage.clear()
  captured.length = 0
  capturedActivations.length = 0
  workbench = undefined
})

const project = {
  id: "project-1",
  worktree: "/repo/main",
  name: "Main",
  workspaces: {
    "/repo/main": { id: "/repo/main", directory: "/repo/main", kind: "local" },
    [WORKSPACE_REF]: { id: WORKSPACE_ID, workspaceId: WORKSPACE_ID, directory: WORKSPACE_REF, kind: "user-hosted" },
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

async function renderSidebarWithHostSession() {
  localStorage.setItem("claxedo.session-view.v1", JSON.stringify({
    group: "project", status: [], environment: [], git: [], archived: "active",
  }))
  renderInRouter(() => (
    <SessionTitleProjectionProvider>
      <ClaxedoStateProvider initialState={emptyClaxedoState()}>
        <WorkbenchProbe />
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
  for (let i = 0; i < 40 && !captured.some((rows) => rows.length > 0); i++) {
    await vi.advanceTimersByTimeAsync(10)
  }
  const navigationIndex = captured.findLastIndex((rows) => rows.some((item) => item.source.sessionId === SESSION_ID))
  const row = captured[navigationIndex]?.find((item) => item.source.sessionId === SESSION_ID)
  const activate = capturedActivations[navigationIndex]
  if (!row || !activate || !workbench) throw new Error("the host's session row was not rendered")
  return { row, activate, workbench }
}

const sessionSurfaces = (state: ReturnType<typeof useClaxedoState>) =>
  state.meta.findAll((item) => item.type === "session" && item.sessionId === SESSION_ID)

describe("rail session row activation on a relay-backed workspace", () => {
  test("opens the surface under the workspace id it writes into the URL", async () => {
    const { row, activate, workbench } = await renderSidebarWithHostSession()

    activate(row)

    expect(window.location.pathname).toBe(`/w/${WORKSPACE_ID}/session/${SESSION_ID}`)
    const surfaces = sessionSurfaces(workbench)
    expect(surfaces).toHaveLength(1)
    expect(surfaces[0]?.directory).toBe(WORKSPACE_REF)
    expect(surfaces[0]?.content?.workspaceRouteId).toBe(WORKSPACE_ID)
    expect(surfaces[0]?.content?.sessionRef).toMatchObject({ sessionId: SESSION_ID, workspaceId: WORKSPACE_ID })
  })

  test("the route layer mirroring that URL reuses the click's surface instead of opening a second one", async () => {
    const { row, activate, workbench } = await renderSidebarWithHostSession()
    activate(row)
    const [opened] = sessionSurfaces(workbench)

    // What `receiveWorkspaceSession` (route-intent.ts) does for
    // `/w/<workspace id>/session/<id>`: open the session under the route's
    // resolved directory, backing and route id.
    const mirrored = workbench.layout.openSession(WORKSPACE_REF, SESSION_ID, "Session", {
      sessionRef: sessionRefForWorkspaceSession({
        sessionId: SESSION_ID,
        directory: WORKSPACE_REF,
        workspace: { workspaceId: WORKSPACE_ID, kind: "machine" },
      }),
      workspaceRouteId: WORKSPACE_ID,
    })

    expect(mirrored).toBe(opened?.id)
    expect(sessionSurfaces(workbench)).toHaveLength(1)
  })
})
