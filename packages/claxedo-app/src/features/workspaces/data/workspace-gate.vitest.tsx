import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createSignal } from "solid-js"
import { WorkspaceGate } from "./workspace-gate"

const calls = vi.hoisted(() => ({
  connection: vi.fn(),
  offline: vi.fn(),
  acquire: vi.fn(() => ({ release: vi.fn() })),
  retry: vi.fn(),
  retainConnection: vi.fn(),
  workspaceRegistry: undefined as undefined | { retainConnection: (input: unknown) => boolean },
}))

vi.mock("../../../app/integrations/claxedo-events", () => ({
  useClaxedoEventsOptional: () => undefined,
}))

vi.mock("@/features/workspaces/app-ports", () => ({
  CloudStartupView: () => <div data-testid="workspace-connecting" />,
  WorkspaceAccessDeniedView: () => <div data-testid="workspace-offline" />,
  // The offline view composes these three, so the mock has to carry them or the
  // whole `offline` branch throws before it can be asserted on.
  WorkspaceStateShell: (props: {
    testId: string
    title: string
    detail?: string
    actions?: unknown
    children?: unknown
  }) => (
    <div data-testid={props.testId}>
      <div>{props.title}</div>
      <div>{props.detail}</div>
      {props.children as never}
      {props.actions as never}
    </div>
  ),
  WorkspaceStateNote: (props: { children?: unknown }) => <div>{props.children as never}</div>,
  WorkspaceStateButton: (props: { testId?: string; onClick: () => void; children?: unknown }) => (
    <button type="button" data-testid={props.testId} onClick={() => props.onClick()}>
      {props.children as never}
    </button>
  ),
  useClaxedoEventsOptional: () => undefined,
}))

vi.mock("./workspace-connection", () => ({
  acquireWorkspaceConnection: calls.acquire,
  retryWorkspaceConnection: calls.retry,
  workspaceConnection: calls.connection,
  workspaceOffline: calls.offline,
}))

vi.mock("./workspace-scope", () => ({
  useWorkspaceScopeRegistryOptional: () => calls.workspaceRegistry,
}))

afterEach(cleanup)

beforeEach(() => {
  calls.connection.mockReset()
  calls.offline.mockReset()
  calls.acquire.mockClear()
  calls.retry.mockReset()
  calls.retainConnection.mockReset()
  calls.workspaceRegistry = undefined
  calls.acquire.mockReturnValue({ release: vi.fn() })
})

describe("WorkspaceGate", () => {
  test("renders a session-shaped fallback while a workspace-backed session connects", () => {
    calls.connection.mockReturnValue({ status: "connecting", phase: "connecting_workspace" })
    calls.offline.mockReturnValue(undefined)

    render(() => (
      <WorkspaceGate
        workspaceId="ws_1"
        kind="user-hosted"
        connectingFallback={<div data-testid="session-page-root" />}
      >
        <div data-testid="ready-session" />
      </WorkspaceGate>
    ))

    expect(screen.getByTestId("session-page-root")).toBeTruthy()
    expect(screen.queryByTestId("ready-session")).toBeNull()
  })

  test("keeps offline states above the session-shaped connecting fallback", () => {
    calls.connection.mockReturnValue({ status: "connecting", phase: "connecting_workspace" })
    calls.offline.mockReturnValue("no-host")

    render(() => (
      <WorkspaceGate
        workspaceId="ws_1"
        kind="user-hosted"
        connectingFallback={<div data-testid="session-page-root" />}
      >
        <div data-testid="ready-session" />
      </WorkspaceGate>
    ))

    expect(screen.getByTestId("workspace-offline")).toBeTruthy()
    expect(screen.queryByTestId("session-page-root")).toBeNull()
  })

  // A dead CLOUD sandbox does not take its history with it: sessions sync back
  // to the control plane, so the surface must still render and let the
  // transcript load centrally. Blocking it behind the offline panel is the bug
  // this branch fixes.
  test.each(["no-host", "unreachable", "still-provisioning", "failed"] as const)(
    "renders the surface for a dead cloud workspace (%s) so central history stays readable",
    (reason) => {
      calls.connection.mockReturnValue({ status: { offline: reason }, terminal: false })
      calls.offline.mockReturnValue(reason)

      render(() => (
        <WorkspaceGate workspaceId="ws_dead" kind="cloud" sessionId="ses_stored">
          <div data-testid="ready-session" />
        </WorkspaceGate>
      ))

      expect(screen.getByTestId("ready-session")).toBeTruthy()
      expect(screen.queryByTestId("workspace-offline")).toBeNull()
    },
  )

  // A DRAFT has no stored history and its first send needs a live runtime, so
  // the offline panel (with its Retry) stays the honest surface.
  test.each([undefined, "new"])("a DRAFT (sessionId=%s) on a dead cloud workspace still shows the offline panel", (sessionId) => {
    calls.connection.mockReturnValue({ status: { offline: "unreachable" }, terminal: false })
    calls.offline.mockReturnValue("unreachable")

    render(() => (
      <WorkspaceGate workspaceId="ws_dead" kind="cloud" sessionId={sessionId}>
        <div data-testid="ready-session" />
      </WorkspaceGate>
    ))

    expect(screen.getByTestId("workspace-offline")).toBeTruthy()
    expect(screen.queryByTestId("ready-session")).toBeNull()
  })

  test("a dead USER-HOSTED workspace still shows the offline panel — it has no central copy", () => {
    calls.connection.mockReturnValue({ status: { offline: "no-host" }, terminal: false })
    calls.offline.mockReturnValue("no-host")

    render(() => (
      <WorkspaceGate workspaceId="ws_uh" kind="user-hosted" sessionId="ses_stored">
        <div data-testid="ready-session" />
      </WorkspaceGate>
    ))

    expect(screen.getByTestId("workspace-offline")).toBeTruthy()
    expect(screen.queryByTestId("ready-session")).toBeNull()
  })

  test("forbidden stays access-denied for cloud — no access means no read", () => {
    calls.connection.mockReturnValue({ status: { offline: "forbidden" }, terminal: true })
    calls.offline.mockReturnValue("forbidden")

    render(() => (
      <WorkspaceGate workspaceId="ws_forbidden" kind="cloud" sessionId="ses_stored">
        <div data-testid="ready-session" />
      </WorkspaceGate>
    ))

    // The children must NOT render. (This stub gives WorkspaceAccessDeniedView
    // the same `workspace-offline` testid as the offline shell, so the
    // meaningful assertion here is the absence of the gated surface.)
    expect(screen.queryByTestId("ready-session")).toBeNull()
    expect(screen.getByTestId("workspace-offline")).toBeTruthy()
  })

  test("standalone gates acquire their own ref-counted handles without a workspace host", () => {
    calls.connection.mockReturnValue({ status: "ready" })
    calls.offline.mockReturnValue(undefined)

    render(() => (
      <>
        <WorkspaceGate workspaceId="ws_split" kind="user-hosted"><div data-testid="pane-a" /></WorkspaceGate>
        <WorkspaceGate workspaceId="ws_split" kind="user-hosted"><div data-testid="pane-b" /></WorkspaceGate>
      </>
    ))

    // Two gates over the same workspace → two acquires; the authority
    // ref-counts these into one shared connection with refs=2 (see
    // workspace-connection.test.ts). A split that stays at refs=1 is therefore
    // NOT the gate/authority — it is a consumer skipping the gate for the
    // second surface.
    const acquiredIds = calls.acquire.mock.calls.map(([input]) => input.workspaceId)
    expect(acquiredIds.filter((id) => id === "ws_split")).toHaveLength(2)
  })

  test("delegates the connection lease to the workspace host", () => {
    calls.retainConnection.mockReturnValue(true)
    calls.workspaceRegistry = { retainConnection: calls.retainConnection }
    calls.connection.mockReturnValue({ status: "ready" })
    calls.offline.mockReturnValue(undefined)

    render(() => (
      <WorkspaceGate workspaceId="ws_owned" kind="cloud" directory="/workspace">
        <div data-testid="ready-session" />
      </WorkspaceGate>
    ))

    expect(calls.retainConnection).toHaveBeenCalledOnce()
    expect(calls.retainConnection).toHaveBeenCalledWith({
      workspaceId: "ws_owned",
      kind: "cloud",
      directory: "/workspace",
    })
    expect(calls.acquire).not.toHaveBeenCalled()
  })

  // RESOLVED 2026-07-11 (WP-B5): the "second pane refs stuck at 1" symptom (e2e
  // core-panes-split-tabs behavior 19) is NOT in this gate or the connection
  // authority — both ref-count correctly (proven above +
  // workspace-connection.test.ts). The earlier `suppressConnectionGate`
  // hypothesis was WRONG: a terminal surface does NOT set that flag. The real
  // cause was workspace RESOLUTION divergence — a newly opened terminal inherits
  // `activeDirectory` (the route key) as its directory, and when that route key
  // disagrees with the signed inventory (a mock `/api/workspace/resolve` that
  // answers `local-<sessionId>` for a directory the inventory calls cloud) the
  // terminal's SessionPaneScope resolves `local` and its gate is a no-op, so no
  // second ref is taken. The two surfaces converging on ONE connection key is now
  // pinned at the resolver layer: session-workspace-key.test.ts, "a session pane
  // and a secondary surface of the same workspace converge on ONE connection key".

  test("reacquires when a fallback workspace kind is refined", () => {
    const firstRelease = vi.fn()
    const secondRelease = vi.fn()
    calls.acquire
      .mockReturnValueOnce({ release: firstRelease })
      .mockReturnValueOnce({ release: secondRelease })
    calls.connection.mockReturnValue({ status: "connecting", phase: "acquiring_sandbox" })
    calls.offline.mockReturnValue(undefined)

    const [kind, setKind] = createSignal<"cloud" | "user-hosted">("user-hosted")
    render(() => (
      <WorkspaceGate
        workspaceId="ws_1"
        kind={kind()}
        directory="workspace:ws_1"
      >
        <div data-testid="ready-session" />
      </WorkspaceGate>
    ))

    expect(calls.acquire).toHaveBeenLastCalledWith({
      workspaceId: "ws_1",
      kind: "user-hosted",
      directory: "workspace:ws_1",
    })

    setKind("cloud")

    expect(firstRelease).toHaveBeenCalledTimes(1)
    expect(calls.acquire).toHaveBeenLastCalledWith({
      workspaceId: "ws_1",
      kind: "cloud",
      directory: "workspace:ws_1",
    })
  })
})
