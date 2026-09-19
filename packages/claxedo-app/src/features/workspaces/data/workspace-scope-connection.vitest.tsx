import { cleanup, render } from "@solidjs/testing-library"
import { Show, createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { WorkspaceGate } from "./workspace-gate"
import { WorkspaceScopeHost } from "./workspace-scope"

const calls = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
}))

vi.mock("@/features/workspaces/app-ports", () => ({
  CloudStartupView: () => <div />,
  WorkspaceAccessDeniedView: () => <div />,
  WorkspaceStateButton: (props: { children?: unknown }) => <button>{props.children as never}</button>,
  WorkspaceStateNote: (props: { children?: unknown }) => <div>{props.children as never}</div>,
  WorkspaceStateShell: (props: { children?: unknown }) => <div>{props.children as never}</div>,
  useClaxedoEventsOptional: () => undefined,
  useDirectorySessionCacheActions: () => ({ refresh: vi.fn() }),
}))

vi.mock("./workspace-connection", () => ({
  acquireWorkspaceConnection: calls.acquire,
  retryWorkspaceConnection: vi.fn(),
  workspaceConnection: () => ({ status: "ready" }),
  workspaceOffline: () => undefined,
}))

beforeEach(() => {
  calls.acquire.mockReset()
  calls.release.mockReset()
  calls.acquire.mockReturnValue({ release: calls.release })
})

afterEach(cleanup)

describe("workspace-scoped connection ownership", () => {
  test("local session switches never enter the workspace connection flow", () => {
    const [sessionId, setSessionId] = createSignal("ses_local_1")
    const mounted = render(() => (
      <WorkspaceScopeHost workspaceIds={() => ["local-association"]}>
        <Show keyed when={sessionId()}>
          {(currentSessionId) => (
            <WorkspaceGate workspaceId={undefined} kind="self" sessionId={currentSessionId}>
              <div>{currentSessionId}</div>
            </WorkspaceGate>
          )}
        </Show>
      </WorkspaceScopeHost>
    ))

    setSessionId("ses_local_2")
    setSessionId("ses_local_1")

    expect(calls.acquire).not.toHaveBeenCalled()
    expect(calls.release).not.toHaveBeenCalled()
    mounted.unmount()
    expect(calls.release).not.toHaveBeenCalled()
  })

  test("switching session gates in one workspace does not reacquire or release its connection", () => {
    const [sessionId, setSessionId] = createSignal("ses_1")
    const mounted = render(() => (
      <WorkspaceScopeHost workspaceIds={() => ["ws_1"]}>
        <Show keyed when={sessionId()}>
          {(currentSessionId) => (
            <WorkspaceGate
              workspaceId="ws_1"
              kind="provisioner"
              directory="/workspace"
              sessionId={currentSessionId}
            >
              <div>{currentSessionId}</div>
            </WorkspaceGate>
          )}
        </Show>
      </WorkspaceScopeHost>
    ))

    expect(calls.acquire).toHaveBeenCalledOnce()
    expect(calls.release).not.toHaveBeenCalled()

    setSessionId("ses_2")

    expect(calls.acquire).toHaveBeenCalledOnce()
    expect(calls.release).not.toHaveBeenCalled()

    mounted.unmount()
    expect(calls.release).toHaveBeenCalledOnce()
  })

  /**
   * A gate whose workspace the host does not own falls back to acquiring the
   * connection itself. Deciding that reads the host's scope set, so the acquire
   * effect used to depend on it: another workspace opening anywhere in the app
   * re-ran this gate, which released and re-acquired, and the connection write
   * that followed fed back into the same derivation. Solid nests a
   * `runUpdates`/`completeUpdates` frame pair per generation, so the ping-pong
   * ran the stack out — `RangeError: Maximum call stack size exceeded`, caught
   * by the app ErrorBoundary, which took the composer's owner down with it.
   * The acquire effect's dependency is its connection input, nothing else.
   */
  test("another workspace entering the host's scope set does not re-acquire an unowned gate's connection", () => {
    const [scopeIds, setScopeIds] = createSignal<readonly string[]>(["ws_owned"])
    const mounted = render(() => (
      <WorkspaceScopeHost workspaceIds={scopeIds}>
        <WorkspaceGate workspaceId="ws_unowned" kind="provisioner" directory="/workspace">
          <div />
        </WorkspaceGate>
      </WorkspaceScopeHost>
    ))

    expect(calls.acquire).toHaveBeenCalledOnce()

    setScopeIds(["ws_owned", "ws_second"])

    expect(calls.acquire).toHaveBeenCalledOnce()
    expect(calls.release).not.toHaveBeenCalled()
    mounted.unmount()
  })
})
