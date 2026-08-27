import { cleanup, render } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { SessionPaneScope } from "./session-pane-scope"

const calls = vi.hoisted(() => ({
  scopeFor: vi.fn(),
  refreshDirectory: vi.fn(),
  directoryRefresh: vi.fn(),
  isWorkspaceReady: vi.fn(),
  connectionResolution: vi.fn(),
  projects: [] as unknown[],
  workspaceGateProps: undefined as
    | undefined
    | {
      workspaceId?: string
      kind?: string
      connectingFallback?: unknown
    },
  directoryScopeProps: undefined as
    | undefined
    | {
      directory: string
      sessionId?: () => string | undefined
      sessionRef?: () => unknown
      harnessType?: () => string | undefined
      workspaceReady?: () => boolean
      refreshDirectory?: unknown
    },
}))

vi.mock("@/platform/runtime/session-workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/runtime/session-workspace")>()
  return {
    ...actual,
    sessionPaneWorkspaceConnection: (...args: Parameters<typeof actual.sessionPaneWorkspaceConnection>) => {
      calls.connectionResolution()
      return actual.sessionPaneWorkspaceConnection(...args)
    },
  }
})

vi.mock("@/features/session/app-ports", () => ({
  DirectoryScope: (props: {
    directory: string
    sessionId?: () => string | undefined
    sessionRef?: () => unknown
    harnessType?: () => string | undefined
    workspaceReady?: () => boolean
    refreshDirectory?: unknown
    children: unknown
  }) => {
    calls.directoryScopeProps = props
    return <div data-testid="directory-scope">{props.children}</div>
  },
  isWorkspaceReady: calls.isWorkspaceReady,
  PaneIdProvider: (props: { children: unknown }) => <>{props.children}</>,
  useGlobalSDK: () => ({ url: "http://localhost:4096" }),
  useShellQueryOptions: () => ({
    projects: () => ({ queryKey: ["projects"], queryFn: async () => calls.projects }),
  }),
  useWorkspaceScopeRegistryOptional: () => ({
    scopeFor: calls.scopeFor,
    refreshDirectory: calls.refreshDirectory,
  }),
  WorkspaceGate: (props: {
    workspaceId?: string
    kind?: string
    connectingFallback?: unknown
    children: unknown
  }) => {
    calls.workspaceGateProps = props
    return <>{props.children}</>
  },
}))

vi.mock("../../data/sync/directory-session-cache", () => ({
  useDirectorySessionCacheActions: () => ({
    refresh: calls.directoryRefresh,
  }),
}))

vi.mock("../../../../app/providers/global-sdk/provider", () => ({
  useGlobalSDK: () => ({
    url: "http://localhost:4096",
  }),
}))

vi.mock("@/platform/runtime/platform-provider", () => ({
  usePlatform: () => ({ fetch }),
}))

vi.mock("@tanstack/solid-query", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/solid-query")>(),
  useQuery: () => ({
    get data() {
      return calls.projects
    },
  }),
}))

// The WorkspaceConnection gate wraps DirectoryScope and only renders it in the
// `ready` branch (driven by the live authority + network). This test asserts the
// prop wiring INTO DirectoryScope, not the gate's connection state machine, so
// stub the gate as a pass-through. The gate's own behavior is covered by
// workspace-connection.test.ts / workspace-connection.invariants.test.ts.
beforeEach(() => {
  calls.scopeFor.mockReset()
  calls.refreshDirectory.mockReset()
  calls.directoryRefresh.mockReset()
  calls.isWorkspaceReady.mockReset()
  calls.connectionResolution.mockReset()
  calls.isWorkspaceReady.mockReturnValue(true)
  calls.scopeFor.mockReturnValue({})
  calls.projects = []
  calls.workspaceGateProps = undefined
  calls.directoryScopeProps = undefined
})

afterEach(cleanup)

describe("SessionPaneScope", () => {
  test("resolves one canonical workspace identity for all pane consumers", () => {
    const [active, setActive] = createSignal(true)
    render(() => (
      <SessionPaneScope
        directory="workspace:ws_one"
        active={active}
        sessionId={() => "ses_1"}
        paneId={() => "pane-1"}
        surfaceId={() => "surface-1"}
      >
        <div>pane content</div>
      </SessionPaneScope>
    ))

    // workspace key, gate props, DirectoryScope props and readiness all read
    // the same memo. A plain resolver accessor invoked it once per read.
    expect(calls.connectionResolution).toHaveBeenCalledOnce()
    setActive(false)
    setActive(true)
    expect(calls.connectionResolution).toHaveBeenCalledOnce()
  })

  test("passes workspace readiness resolved from SessionRef backing into DirectoryScope", async () => {
    render(() => (
      <SessionPaneScope
        directory="/repo/local"
        sessionRef={() => ({
          sessionId: "ses_1",
          host: "workspace",
          workspaceId: "ws_backing",
          toolSandbox: { kind: "workspace", workspaceId: "ws_backing", hosting: "cloud" },
          harness: { id: "codex-acp" },
        })}
        sessionId={() => "fallback-session"}
        paneId={() => "pane-1"}
        surfaceId={() => "surface-1"}
      >
        <div>pane content</div>
      </SessionPaneScope>
    ))

    expect(calls.directoryScopeProps?.directory).toBe("/repo/local")
    expect(calls.directoryScopeProps?.sessionId?.()).toBe("ses_1")
    expect(calls.directoryScopeProps?.harnessType?.()).toBe("codex-acp")
    expect(calls.directoryScopeProps?.workspaceReady?.()).toBe(true)
    expect(calls.directoryScopeProps?.refreshDirectory).toBeTypeOf("function")
    await (calls.directoryScopeProps?.refreshDirectory as (directory: string, harnessType?: string) => unknown)(
      "/repo/local",
      "opencode",
    )
    expect(calls.refreshDirectory).toHaveBeenCalledWith("/repo/local", "opencode", {
      workspace: { workspaceId: "ws_backing", kind: "cloud" },
    })
    expect(calls.scopeFor).toHaveBeenCalledWith("ws_backing")
  })

  test("treats local filesystem panes as ready without a workspace scope registry entry", () => {
    calls.scopeFor.mockReturnValue(undefined)

    render(() => (
      <SessionPaneScope
        directory="/repo/local"
        sessionRef={() => ({
          sessionId: "ses_local",
          host: "workspace",
          cwd: "/repo/local",
          toolSandbox: { kind: "local", cwd: "/repo/local" },
        })}
        paneId={() => "pane-1"}
        surfaceId={() => "surface-1"}
      >
        <div>pane content</div>
      </SessionPaneScope>
    ))

    expect(calls.workspaceGateProps?.workspaceId).toBeUndefined()
    expect(calls.directoryScopeProps?.workspaceReady?.()).toBe(true)
    expect(calls.scopeFor).not.toHaveBeenCalled()
  })

  test("passes filesystem user-hosted readiness through the connection authority", () => {
    calls.projects = [{
      workspaces: {
        ws_cleantest1: {
          workspaceId: "ws_cleantest1",
          kind: "user-hosted",
          directory: "/tmp/claxedo-portability/ws_cleantest1-dir",
        },
      },
    }]

    render(() => (
      <SessionPaneScope
        directory="/private/tmp/claxedo-portability/ws_cleantest1-dir"
        sessionRef={() => ({
          sessionId: "ses_1",
          host: "workspace",
          cwd: "/private/tmp/claxedo-portability/ws_cleantest1-dir",
          toolSandbox: { kind: "local", cwd: "/private/tmp/claxedo-portability/ws_cleantest1-dir" },
        })}
        paneId={() => "pane-1"}
        surfaceId={() => "surface-1"}
      >
        <div>pane content</div>
      </SessionPaneScope>
    ))

    expect(calls.directoryScopeProps?.workspaceReady?.()).toBe(true)
    expect(calls.scopeFor).toHaveBeenCalledWith("ws_cleantest1")
  })

  test("does not mask user-hosted connection progress with a session loading fallback", () => {
    calls.projects = [{
      workspaces: {
        ws_cleantest1: {
          workspaceId: "ws_cleantest1",
          kind: "user-hosted",
          directory: "/tmp/claxedo-portability/ws_cleantest1-dir",
        },
      },
    }]

    render(() => (
      <SessionPaneScope
        directory="/tmp/claxedo-portability/ws_cleantest1-dir"
        sessionRef={() => ({
          sessionId: "ses_1",
          host: "workspace",
          cwd: "/tmp/claxedo-portability/ws_cleantest1-dir",
          toolSandbox: { kind: "local", cwd: "/tmp/claxedo-portability/ws_cleantest1-dir" },
        })}
        connectionFallback={<div data-testid="session-page-root" />}
      >
        <div>pane content</div>
      </SessionPaneScope>
    ))

    expect(calls.workspaceGateProps?.workspaceId).toBe("ws_cleantest1")
    expect(calls.workspaceGateProps?.kind).toBe("user-hosted")
    expect(calls.workspaceGateProps?.connectingFallback).toBeUndefined()
  })

  test("falls back to direct directory cache refresh when workspace scope host is behind", async () => {
    render(() => (
      <SessionPaneScope
        directory="/repo/local"
        sessionId={() => "ses_1"}
        paneId={() => "pane-1"}
        surfaceId={() => "surface-1"}
      >
        <div>pane content</div>
      </SessionPaneScope>
    ))

    await (calls.directoryScopeProps?.refreshDirectory as (directory: string, harnessType?: string) => unknown)(
      "/repo/local",
      "opencode",
    )

    expect(calls.directoryRefresh).toHaveBeenCalledWith({ directory: "/repo/local", harnessType: "opencode" })
    expect(calls.refreshDirectory).toHaveBeenCalledWith("/repo/local", "opencode", undefined)
  })
})
