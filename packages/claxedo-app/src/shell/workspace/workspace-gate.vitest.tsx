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

vi.mock("../../context/claxedo-events", () => ({
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

  // Cross-file pin (DISCOVERED-BUG rule): the "second pane refs stuck at 1"
  // symptom (e2e core-panes-split-tabs behavior 19) is NOT in this gate or the
  // connection authority — both ref-count correctly (proven above +
  // workspace-connection.test.ts). Its cause is
  // `claxedo-ui/components/session-pane-scope.tsx:38,121` — when
  // `suppressConnectionGate` is set (the Review panel / secondary surfaces),
  // the pane renders its child DIRECTLY with no `acquireWorkspaceConnection`,
  // so no second ref is ever taken. Owned by WP-B1.
  test.todo(
    "secondary surfaces sharing a relay workspace must take a ref instead of skipping WorkspaceGate (WP-B1: session-pane-scope suppressConnectionGate)",
  )

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
