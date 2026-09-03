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
            <WorkspaceGate workspaceId={undefined} kind="local" sessionId={currentSessionId}>
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
              kind="cloud"
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
})
