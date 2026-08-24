import { cleanup, render, waitFor } from "@solidjs/testing-library"
import { createEffect, createSignal } from "solid-js"
import { afterEach, describe, expect, test, vi } from "vitest"
import { SessionEnvironmentCardMount } from "./session-environment-card"

type QueryOptions = {
  queryKey: readonly unknown[]
  enabled?: boolean
  staleTime?: number
  refetchInterval?: number | false
  queryFn: () => unknown
}

const harness = vi.hoisted(() => ({
  options: [] as Array<() => QueryOptions>,
  enabledOwners: [] as string[],
  fetchedAt: new Map<string, number>(),
  quietDelayMs: 0,
  panelState: () => ({ open: false }),
  status: vi.fn(async () => ({ data: [] })),
  vcs: vi.fn(async () => ({ branch: "main" })),
  processes: vi.fn(async () => ({ configs: [], processes: [] })),
}))

const targetKey = (queryKey: readonly unknown[]) => {
  if (queryKey[0] === "session-environment") return queryKey[1] as string
  if (queryKey[0] === "directory" && queryKey[2] === "fileStatus") return "file-status"
  if (queryKey[0] === "runtime" && queryKey[1] === "vcs") return "vcs"
  return undefined
}

vi.mock("@tanstack/solid-query", () => ({
  queryOptions: (options: QueryOptions) => options,
  useQuery: (options: () => QueryOptions) => {
    harness.options.push(options)
    let wasEnabled = false
    createEffect(() => {
      const current = options()
      const key = targetKey(current.queryKey)
      const enabled = current.enabled !== false
      if (key && enabled && !wasEnabled) {
        const fetchedAt = harness.fetchedAt.get(key)
        const staleTime = current.staleTime ?? 0
        if (fetchedAt === undefined || Date.now() - fetchedAt >= staleTime) {
          harness.enabledOwners.push(key)
          harness.fetchedAt.set(key, Date.now())
          void current.queryFn()
        }
      }
      wasEnabled = enabled
    })
    return { data: undefined }
  },
}))

vi.mock("@/features/session/app-ports", () => ({
  useSDK: () => ({
    directory: "/work/repo",
    url: "http://opencode.test",
    client: { file: { status: harness.status } },
    workspace: () => undefined,
    workspaceId: undefined,
  }),
  useClaxedoState: () => ({
    workspacePanel: {
      state: () => harness.panelState(),
      open: vi.fn(),
    },
    layout: { openTerminal: vi.fn() },
  }),
  useShellQueryOptions: () => ({
    projects: () => ({ queryKey: ["projects"], queryFn: async () => [] }),
  }),
  createProcessClient: () => ({ list: harness.processes }),
  parseOwnerRepo: () => undefined,
}))

vi.mock("@/features/session/providers/prompt", () => ({
  usePrompt: () => ({ dirty: () => false, current: () => [], set: vi.fn() }),
}))

vi.mock("@/platform/runtime/platform-provider", () => ({
  usePlatform: () => ({ openLink: vi.fn() }),
}))

vi.mock("@/platform/runtime/session-switch", () => ({
  fastSessionSwitchAnyQuietDelay: ({ baseDelay = 0 }: { baseDelay?: number }) =>
    Math.max(baseDelay, harness.quietDelayMs),
}))

vi.mock("@/platform/api/api", () => ({
  getClaxedoServerUrl: () => "http://claxedo.test",
  normalizeUrl: (value?: string) => value,
}))

vi.mock("@/platform/runtime/workspace-query", () => ({
  workspaceVcsQuery: () => ({
    queryKey: ["runtime", "vcs", "/work/repo"],
    queryFn: harness.vcs,
  }),
}))

vi.mock("@/platform/runtime/workspace-runtime-record", () => ({
  resolveWorkspaceRuntime: vi.fn(),
}))

vi.mock("@/platform/runtime/agent/signed-workspace", () => ({
  sameWorkspaceDirectory: (left: string, right: string) => left === right,
}))

vi.mock("@/platform/persistence/persist", () => ({
  Persist: { global: (key: string) => key },
  persisted: (_key: string, store: { collapsed: boolean }) => [
    store,
    (_path: string, value: boolean) => { store.collapsed = value },
    undefined,
    () => true,
  ],
}))

afterEach(() => {
  cleanup()
  harness.options.length = 0
  harness.enabledOwners.length = 0
  harness.fetchedAt.clear()
  harness.quietDelayMs = 0
  harness.panelState = () => ({ open: false })
  harness.status.mockClear()
  harness.vcs.mockClear()
  harness.processes.mockClear()
  vi.useRealTimers()
})

describe("SessionEnvironmentCardMount query ownership", () => {
  test("a retained hidden card owns no requests or poller, then one visible card owns each query", async () => {
    vi.useFakeTimers()
    const [active, setActive] = createSignal(false)
    const [panelOpen, setPanelOpen] = createSignal(false)
    harness.panelState = () => ({ open: panelOpen() })

    render(() => <SessionEnvironmentCardMount active={active} />)

    const targetOptions = () => harness.options.map((options) => options()).filter((options) => targetKey(options.queryKey))
    const processesOptions = () => targetOptions().find((options) => targetKey(options.queryKey) === "processes")

    await Promise.resolve()
    expect(targetOptions()).toHaveLength(3)
    expect(targetOptions().every((options) => options.enabled === false)).toBe(true)
    expect(processesOptions()?.refetchInterval).toBe(false)
    expect(harness.enabledOwners).toEqual([])
    expect(harness.status).not.toHaveBeenCalled()
    expect(harness.vcs).not.toHaveBeenCalled()
    expect(harness.processes).not.toHaveBeenCalled()

    harness.quietDelayMs = 2_000
    setActive(true)

    await waitFor(() => {
      expect(harness.enabledOwners).toEqual(["vcs"])
    })
    expect(targetOptions().find((options) => targetKey(options.queryKey) === "file-status")?.enabled).toBe(false)
    expect(targetOptions().find((options) => targetKey(options.queryKey) === "vcs")?.enabled).toBe(true)
    expect(processesOptions()?.enabled).toBe(false)
    expect(processesOptions()?.refetchInterval).toBe(false)
    expect(harness.status).not.toHaveBeenCalled()
    expect(harness.vcs).toHaveBeenCalledOnce()
    expect(harness.processes).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_999)
    expect(processesOptions()?.enabled).toBe(false)
    expect(harness.processes).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(processesOptions()?.enabled).toBe(true)
    expect(processesOptions()?.staleTime).toBe(5_000)
    expect(processesOptions()?.refetchInterval).toBe(5_000)
    expect(harness.processes).toHaveBeenCalledOnce()

    // The shared workspace panel remains the global suppression policy even
    // for the currently painted pane.
    setPanelOpen(true)
    expect(targetOptions().every((options) => options.enabled === false)).toBe(true)
    expect(processesOptions()?.refetchInterval).toBe(false)

    setPanelOpen(false)
    setActive(false)
    expect(targetOptions().every((options) => options.enabled === false)).toBe(true)
    expect(processesOptions()?.refetchInterval).toBe(false)

    // Returning to a retained card paints its cached process snapshot. It does
    // not turn the session click into another process request while that
    // snapshot is inside the card's existing five-second poll contract.
    harness.quietDelayMs = 0
    setActive(true)
    await vi.advanceTimersByTimeAsync(250)
    expect(processesOptions()?.enabled).toBe(true)
    expect(harness.processes).toHaveBeenCalledOnce()

    setActive(false)
    await vi.advanceTimersByTimeAsync(5_001)
    setActive(true)
    await vi.advanceTimersByTimeAsync(250)
    expect(harness.processes).toHaveBeenCalledTimes(2)
  })
})
