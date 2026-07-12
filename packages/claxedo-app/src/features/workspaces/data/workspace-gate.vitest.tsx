import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createSignal } from "solid-js"
import { WorkspaceGate } from "./workspace-gate"

const calls = vi.hoisted(() => ({
  connection: vi.fn(),
  offline: vi.fn(),
  acquire: vi.fn(() => ({ release: vi.fn() })),
  retry: vi.fn(),
}))

vi.mock("../../../app/integrations/claxedo-events", () => ({
  useClaxedoEventsOptional: () => undefined,
}))

vi.mock("@/features/workspaces/app-ports", () => ({
  CloudStartupView: () => <div data-testid="workspace-connecting" />,
  WorkspaceAccessDeniedView: () => <div data-testid="workspace-offline" />,
  useClaxedoEventsOptional: () => undefined,
}))

vi.mock("./workspace-connection", () => ({
  acquireWorkspaceConnection: calls.acquire,
  retryWorkspaceConnection: calls.retry,
  workspaceConnection: calls.connection,
  workspaceOffline: calls.offline,
}))

afterEach(cleanup)

beforeEach(() => {
  calls.connection.mockReset()
  calls.offline.mockReset()
  calls.acquire.mockClear()
  calls.retry.mockReset()
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

  test("each mounted gate over the same workspace acquires its own ref-counted handle", () => {
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
