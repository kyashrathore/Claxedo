import { cleanup, render, waitFor } from "@solidjs/testing-library"
import { QueryClientProvider, skipToken, useQuery } from "@tanstack/solid-query"
import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { afterEach, describe, expect, test, vi } from "vitest"
import { queryClient } from "@/platform/query/query-client"
import { localSelectionHandoffQueryKey } from "@/features/session/store/local-selection-handoff"
import {
  sessionConfigRawQueryKey,
  sessionConfigSelectionQueryKey,
} from "@/features/session/store/session-config-selection"

const harness = vi.hoisted(() => ({
  configRequests: 0,
  quietDelayMs: 0,
  deferConfig: false,
  configSignals: [] as AbortSignal[],
}))

vi.mock("@/platform/runtime/session-switch", () => ({
  fastSessionSwitchAnyQuietDelay: ({ baseDelay = 0 }: { baseDelay?: number }) =>
    Math.max(baseDelay, harness.quietDelayMs),
}))

vi.mock("@/platform/runtime/platform-provider", () => ({
  usePlatform: () => ({ fetch: vi.fn() }),
}))

vi.mock("@/platform/runtime/agent/agent-runtime-client", () => ({
  createAgentRuntimeClient: () => ({
    getSessionConfig: async (input: { signal?: AbortSignal }) => {
      harness.configRequests++
      if (input.signal) harness.configSignals.push(input.signal)
      if (harness.deferConfig) {
        await new Promise<void>((_resolve, reject) => {
          input.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
        })
      }
      return {
        harness: { id: "opencode", access: "native" },
        agent: "build",
        model: { providerID: "opencode", modelID: "model-restored" },
        variant: null,
      }
    },
    updateSessionConfig: vi.fn(),
  }),
}))

vi.mock("../data/query/directory", () => ({
  configQuery: () => ({
    queryKey: ["directory-config"],
    staleTime: Infinity,
    queryFn: async () => ({}),
  }),
  agentListQuery: () => ({
    queryKey: ["directory-agents"],
    staleTime: Infinity,
    queryFn: async () => [{
      name: "build",
      mode: "primary",
      model: { providerID: "opencode", modelID: "model-restored" },
    }],
  }),
}))

vi.mock("@/features/session/app-ports", () => ({
  useSDK: () => ({
    url: "http://opencode.test",
    directory: "/repo",
    client: {},
    workspace: () => undefined,
  }),
  useProviders: () => ({
    all: () => new Map([["opencode", {
      id: "opencode",
      models: { "model-restored": { id: "model-restored" } },
    }]]),
    connected: () => [{ id: "opencode" }],
    default: () => ({ opencode: "model-restored" }),
    load: vi.fn(async () => undefined),
  }),
  useWorkspaceQuery: (options: () => Parameters<typeof useQuery>[0]) => useQuery(options),
}))

vi.mock("@/features/session/providers/models", () => ({
  useModels: () => ({
    ready: () => true,
    recent: { list: () => [], push: vi.fn() },
    find: (model: { providerID: string; modelID: string }) => ({
      id: model.modelID,
      provider: { id: model.providerID },
      variants: {},
    }),
    list: () => [],
    hydrate: vi.fn(),
    visible: () => true,
    setVisibility: vi.fn(),
    variant: { get: () => undefined, set: vi.fn() },
  }),
}))

vi.mock("@/platform/persistence/persist", () => ({
  Persist: { workspace: () => ({}) },
  persisted: (_key: unknown, value: ReturnType<typeof createStore>) => [value[0], value[1], undefined, () => true],
}))

import { LocalProvider, useLocal } from "./session-selection"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  harness.configRequests = 0
  harness.quietDelayMs = 0
  harness.deferConfig = false
  harness.configSignals.length = 0
  queryClient.clear()
})

describe("session selection hydration scheduling", () => {
  test("keeps config off the first fold and restores the composer after quiet", async () => {
    vi.useFakeTimers()
    harness.quietDelayMs = 2_000

    const Probe = () => {
      const local = useLocal()
      return (
        <div
          data-testid="selection"
          data-pending={local.model.restorePending() ? "true" : "false"}
          data-model={local.model.selected()?.modelID ?? ""}
        />
      )
    }

    const view = render(() => (
      <QueryClientProvider client={queryClient}>
        <LocalProvider sessionId={() => "ses_existing"}>
          <Probe />
        </LocalProvider>
      </QueryClientProvider>
    ))

    await vi.advanceTimersByTimeAsync(1_999)
    expect(harness.configRequests).toBe(0)
    expect(view.getByTestId("selection")).toHaveAttribute("data-pending", "true")
    expect(view.getByTestId("selection")).toHaveAttribute("data-model", "")
    expect(queryClient.getQueryCache().find({
      queryKey: ["shell", "pane-observer", { state: "parked", reason: "no-session" }, "session-config-raw"],
    })?.options.queryFn).toBe(skipToken)
    expect(queryClient.getQueryCache().find({
      queryKey: ["shell", "pane-observer", { state: "parked", reason: "no-session" }, "session-config-selection"],
    })?.options.queryFn).toBe(skipToken)
    expect(queryClient.getQueryCache().find({
      queryKey: localSelectionHandoffQueryKey("ses_existing"),
    })?.options.queryFn).toBe(skipToken)

    await vi.advanceTimersByTimeAsync(1)
    await waitFor(() => {
      expect(harness.configRequests).toBe(1)
      expect(view.getByTestId("selection")).toHaveAttribute("data-pending", "false")
      expect(view.getByTestId("selection")).toHaveAttribute("data-model", "model-restored")
    })
  })

  test("aborts an active config read when its session owner becomes inactive", async () => {
    vi.useFakeTimers()
    harness.deferConfig = true
    const [sessionID, setSessionID] = createSignal<string | undefined>("ses_a")

    render(() => (
      <QueryClientProvider client={queryClient}>
        <LocalProvider sessionId={sessionID}>
          <div />
        </LocalProvider>
      </QueryClientProvider>
    ))

    await vi.advanceTimersByTimeAsync(250)
    expect(harness.configRequests).toBe(1)
    expect(harness.configSignals[0]?.aborted).toBe(false)

    setSessionID(undefined)
    await waitFor(() => expect(harness.configSignals[0]?.aborted).toBe(true))
    const scope = {
      sessionID: "ses_a",
      directory: "/repo",
      serverUrl: "http://opencode.test",
    }
    expect(queryClient.getQueryData(sessionConfigRawQueryKey(scope))).toBeUndefined()
    expect(queryClient.getQueryData(sessionConfigSelectionQueryKey(scope))).toBeUndefined()
    expect(queryClient.getQueryCache().find({
      queryKey: sessionConfigRawQueryKey(scope),
    })?.options.queryFn).toBeTypeOf("function")
  })
})
