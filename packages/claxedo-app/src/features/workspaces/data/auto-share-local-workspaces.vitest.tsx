import { cleanup, render, waitFor } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { createEffect, createMemo, createSignal, type Accessor } from "solid-js"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  LocalWorkspaceAutoShareProvider,
  localWorkspaceShareCandidates,
  useLocalWorkspaceAutoShareStatus,
} from "./auto-share-local-workspaces"

/**
 * The port is the only thing stubbed.
 *
 * Everything between the hook and it is the real path: the real
 * `registerUserHostedWorkspace` (which routes through `port.shareWorkspace`
 * when a connector is bound), the real `localWorkspaceShareTarget` kind
 * filter, and the real `useSharedWorkspaceIds` query. Stubbing the share
 * helper instead would have tested the test's idea of the boundary.
 */
const connector = vi.hoisted(() => {
  const shared: string[] = []
  const listeners = new Set<() => void>()
  return {
    shared,
    listeners,
    enabled: true,
    shareCalls: [] as Array<{ workspaceId: string; displayName?: string }>,
    unshareCalls: [] as string[],
    failWith: undefined as string | undefined,
    /** What the desktop connector does on any transition it did not cause. */
    push() {
      for (const listener of listeners) listener()
    },
    port: {
      async status() {
        return {
          deviceLoginConfigured: true,
          relayConfigured: true,
          hostedSignedIn: true,
          enrolled: connector.enabled,
          enabled: connector.enabled,
          secondDeviceOpen: false,
          sharedWorkspaceIds: [...shared],
        }
      },
      subscribe(listener: () => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      async shareWorkspace(input: { workspaceId: string; displayName?: string }) {
        connector.shareCalls.push(input)
        if (connector.failWith) throw new Error(connector.failWith)
        shared.push(input.workspaceId)
      },
      async unshareWorkspace(workspaceId: string) {
        connector.unshareCalls.push(workspaceId)
      },
      async enable() {},
      async revoke() {
        return { revoked: true }
      },
    },
  }
})

vi.mock("@/platform/remote-access/machine-remote-access", () => ({
  machineRemoteAccess: () => connector.port,
}))

type Project = { id?: string; worktree: string; workspaces?: Record<string, { directory?: string; id?: string; kind?: string }> }

function project(worktree: string, workspaces: Record<string, { directory: string; id: string; kind?: string }>): Project {
  return { id: worktree, worktree, workspaces }
}

/**
 * Mount the shell's provider, and read it the way a panel does — through
 * `useLocalWorkspaceAutoShareStatus()` from inside its subtree, so the seam the
 * surfaces actually use is the one under test.
 */
function mount(input: { projects: Accessor<readonly Project[] | undefined> }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // The reader has to run INSIDE the provider's subtree — that is the whole
  // point of the seam — so a probe component reads it and mirrors the latest
  // value out for the assertions.
  let latest: ReturnType<typeof useLocalWorkspaceAutoShareStatus> = {}
  const Probe = () => {
    const status = createMemo(() => useLocalWorkspaceAutoShareStatus())
    createEffect(() => { latest = status() })
    return null
  }
  render(() => (
    <QueryClientProvider client={client}>
      <LocalWorkspaceAutoShareProvider projects={input.projects}>
        <Probe />
      </LocalWorkspaceAutoShareProvider>
    </QueryClientProvider>
  ))
  return () => latest
}

beforeEach(() => {
  connector.shared.length = 0
  connector.listeners.clear()
  connector.enabled = true
  connector.shareCalls.length = 0
  connector.unshareCalls.length = 0
  connector.failWith = undefined
})

afterEach(() => cleanup())

describe("localWorkspaceShareCandidates", () => {
  test("keeps only what this machine can publish, once each", () => {
    const candidates = localWorkspaceShareCandidates([
      project("/code/api", {
        "/code/api": { directory: "/code/api", id: "ws_api" },
        "/code/api/feature": { directory: "/code/api/feature", id: "ws_feature" },
        // The control plane's echo of this machine's own registration, and a
        // cloud workspace: both are remote representations, neither is a
        // directory this machine can publish.
        "/code/api/hosted": { directory: "/code/api/hosted", id: "ws_hosted", kind: "user-hosted" },
        "/code/api/cloud": { directory: "/code/api/cloud", id: "ws_cloud", kind: "cloud" },
      }),
    ])

    expect(candidates.map((entry) => entry.workspaceId)).toEqual(["ws_api", "ws_feature"])
    expect(candidates[0]).toMatchObject({ label: "api", path: "/code/api" })
  })
})

describe("machine-level auto-share", () => {
  test("turning remote access on publishes every local workspace, with no tick from anyone", async () => {
    connector.enabled = false
    const projects = () => [
      project("/code/api", {
        "/code/api": { directory: "/code/api", id: "ws_api" },
        "/code/web": { directory: "/code/web", id: "ws_web" },
      }),
    ]
    const auto = mount({ projects })

    await waitFor(() => expect(auto().pending).toBe("Remote access is off"))
    expect(connector.shareCalls).toEqual([])

    // The connector reports itself up, and pushes that transition.
    connector.enabled = true
    connector.push()
    await waitFor(() => expect(auto().serving).toBe(2))
    expect(connector.shareCalls.map((call) => call.workspaceId)).toEqual(["ws_api", "ws_web"])
    expect(auto().pending).toBeUndefined()
  })

  test("a workspace opened afterwards is published on the next inventory change", async () => {
    const [projects, setProjects] = createSignal<readonly Project[]>([
      project("/code/api", { "/code/api": { directory: "/code/api", id: "ws_api" } }),
    ])
    const auto = mount({ projects })

    await waitFor(() => expect(auto().serving).toBe(1))

    setProjects([
      project("/code/api", { "/code/api": { directory: "/code/api", id: "ws_api" } }),
      project("/code/new", { "/code/new": { directory: "/code/new", id: "ws_new" } }),
    ])

    await waitFor(() => expect(auto().serving).toBe(2))
    // Only the new one was asked for; the already-published one was not
    // re-posted.
    expect(connector.shareCalls.map((call) => call.workspaceId)).toEqual(["ws_api", "ws_new"])
  })

  test("a failed publish is reported once and does NOT retry until something changes", async () => {
    connector.failWith = "relay rejected the workspace"
    const [projects, setProjects] = createSignal<readonly Project[]>([
      project("/code/api", { "/code/api": { directory: "/code/api", id: "ws_api" } }),
    ])
    const auto = mount({ projects })

    await waitFor(() => expect(auto().failure).toEqual({
      label: "api",
      message: "relay rejected the workspace",
    }))
    expect(auto().pending).toBe("Some workspaces are not published yet")
    expect(connector.shareCalls).toHaveLength(1)

    // Nothing changed: neither the published set nor the inventory. An
    // unattended laptop must not hammer the assignment endpoint behind a
    // workspace that keeps failing.
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(connector.shareCalls).toHaveLength(1)

    // Nor when the inventory RECOMPUTES without actually changing what is
    // missing — here a cloud workspace appears, which this machine can never
    // publish. The derived list is a fresh array every time, so only comparing
    // its CONTENT keeps the pass from firing again.
    setProjects([
      project("/code/api", {
        "/code/api": { directory: "/code/api", id: "ws_api" },
        "/code/api/cloud": { directory: "/code/api/cloud", id: "ws_cloud", kind: "cloud" },
      }),
    ])
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(connector.shareCalls).toHaveLength(1)

    // The next real change is what retries it — and this time it lands.
    connector.failWith = undefined
    setProjects([
      project("/code/api", { "/code/api": { directory: "/code/api", id: "ws_api" } }),
      project("/code/web", { "/code/web": { directory: "/code/web", id: "ws_web" } }),
    ])
    await waitFor(() => expect(auto().serving).toBe(2))
    expect(auto().failure).toBeUndefined()
  })

  test("it never withdraws a workspace — machine level has no exclusions", async () => {
    connector.shared.push("ws_gone")
    const auto = mount({
      projects: () => [project("/code/api", { "/code/api": { directory: "/code/api", id: "ws_api" } })],
    })

    await waitFor(() => expect(auto().serving).toBe(2))
    // `ws_gone` is published but no longer in the local inventory. A tick list
    // would have unticked it; machine-level sharing leaves it entirely alone.
    expect(connector.unshareCalls).toEqual([])
  })

  test("a second provider is inert — one machine gets one pass, not one per mount", async () => {
    const projects = () => [
      project("/code/api", {
        "/code/api": { directory: "/code/api", id: "ws_api" },
        "/code/web": { directory: "/code/web", id: "ws_web" },
      }),
    ]
    const auto = mount({ projects })
    // A surface that mistakenly wraps its own provider instead of reading must
    // not double every assignment POST for the one machine that exists.
    mount({ projects })

    await waitFor(() => expect(auto().serving).toBe(2))
    expect(connector.shareCalls.map((call) => call.workspaceId)).toEqual(["ws_api", "ws_web"])
  })

  test("a connector transition nobody asked about re-reads the published set", async () => {
    // The user enables remote access from Settings, or a heartbeat is
    // rejected elsewhere. Waiting out the query's 30s stale window would leave
    // the machine serving nothing for half a minute after it came up.
    connector.enabled = false
    const auto = mount({
      projects: () => [project("/code/api", { "/code/api": { directory: "/code/api", id: "ws_api" } })],
    })
    await waitFor(() => expect(auto().pending).toBe("Remote access is off"))

    connector.enabled = true
    connector.push()
    await waitFor(() => expect(auto().serving).toBe(1))
    expect(auto().pending).toBeUndefined()
  })

  test("nothing is published while the machine is not up, or before the sets are known", async () => {
    const [projects, setProjects] = createSignal<readonly Project[] | undefined>(undefined)
    const auto = mount({ projects })

    await waitFor(() => expect(auto().pending).toBe("Reading this machine's workspaces"))
    expect(connector.shareCalls).toEqual([])

    setProjects([project("/code/api", { "/code/api": { directory: "/code/api", id: "ws_api" } })])
    await waitFor(() => expect(auto().serving).toBe(1))
  })
})
