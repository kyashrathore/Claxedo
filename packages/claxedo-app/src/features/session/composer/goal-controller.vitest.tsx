/**
 * Composer Goal toggle — capability resolution on arm.
 *
 * Goal capabilities for an EXISTING session arrive through the session owner's
 * deferred secondary hydration. The toggle must not refuse while they are still
 * unknown: `/goal <objective>` fetches capabilities itself before starting, and
 * the two entry paths have to agree.
 */

import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, render, waitFor } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { createSignal } from "solid-js"
import type { AgentRuntimeGoalCapabilities } from "@/platform/runtime/agent/agent-runtime-client"
import { createComposerGoalController } from "./goal-controller"
import type { HarnessSelection } from "@/platform/identity/harness-selection"
import { fetchSessionCapabilitiesByTransport } from "@/features/session/store/session-transport"

vi.mock("@/features/session/store/session-transport", () => ({ fetchSessionCapabilitiesByTransport: vi.fn() }))

const available: AgentRuntimeGoalCapabilities = {
  implemented: true,
  available: true,
  actions: ["pause", "resume", "delete"],
  recovery: "reconcile",
  optionalFields: [],
}

function mountController(input: {
  capabilities: () => AgentRuntimeGoalCapabilities | undefined
  refreshGoal?: (opts?: { force?: boolean }) => Promise<boolean>
  isNewSession?: boolean
  harness?: () => HarnessSelection
}) {
  const [armed, setArmed] = createSignal(false)
  const unavailable: Array<string | undefined> = []
  let controller!: ReturnType<typeof createComposerGoalController>
  const Subject = () => {
        controller = createComposerGoalController({
          isNewSession: () => input.isNewSession ?? false,
          harness: input.harness ?? (() => ({ kind: "native", harnessId: "pi" })),
          harnessPending: () => false,
          directory: () => "/repo/main",
          serverUrl: () => "http://127.0.0.1:3001",
          signedControlPlane: () => false,
          workspaceId: () => undefined,
          hostKind: () => undefined,
          sessionRef: () => undefined,
          sessionCapabilities: input.capabilities,
          ...(input.refreshGoal ? { refreshGoal: input.refreshGoal } : {}),
          armed,
          setArmed,
          unavailable: (reason) => unavailable.push(reason),
          normalizeMode: () => {},
          focus: () => {},
        })
        return <span data-testid="goal-available">{String(controller.available())}</span>
  }
  render(() => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Subject />
    </QueryClientProvider>
  ))
  return { controller, armed, unavailable }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("composer Goal toggle", () => {
  test("isolates same-named native and connection capability caches when switching drafts", async () => {
    const read = vi.mocked(fetchSessionCapabilitiesByTransport)
    read.mockImplementation(async ({ harness }) => ({ goals: harness?.kind === "native" }) as never)
    const [harness, setHarness] = createSignal<HarnessSelection>({ kind: "native", harnessId: "pi" })
    const { controller } = mountController({ capabilities: () => undefined, isNewSession: true, harness })
    await waitFor(() => expect(controller.available()).toBe(true))
    setHarness({ kind: "connection", connectionId: "pi" })
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(controller.available()).toBe(false))
    expect(read.mock.calls.map(([input]) => input.harness)).toEqual([
      { kind: "native", harnessId: "pi" }, { kind: "connection", connectionId: "pi" },
    ])
    setHarness({ kind: "native", harnessId: "pi" })
    await waitFor(() => expect(controller.available()).toBe(true))
    expect(read).toHaveBeenCalledTimes(2)
  })
  test("fetches capabilities on demand instead of refusing before hydration", async () => {
    const [capabilities, setCapabilities] = createSignal<AgentRuntimeGoalCapabilities | undefined>(undefined)
    let refreshes = 0
    const { controller, armed, unavailable } = mountController({
      capabilities,
      refreshGoal: async () => {
        refreshes += 1
        setCapabilities(available)
        return true
      },
    })

    await controller.arm()

    expect(refreshes).toBe(1)
    expect(armed()).toBe(true)
    expect(unavailable).toEqual([])
  })

  test("reports the runtime's reason once the on-demand read says Goals are unavailable", async () => {
    const [capabilities, setCapabilities] = createSignal<AgentRuntimeGoalCapabilities | undefined>(undefined)
    const { controller, armed, unavailable } = mountController({
      capabilities,
      refreshGoal: async () => {
        setCapabilities({
          implemented: true,
          available: false,
          unavailableReason: "provider did not negotiate Goal",
          actions: [],
          recovery: "blocked",
          optionalFields: [],
        })
        return true
      },
    })

    await controller.arm()

    expect(armed()).toBe(false)
    expect(unavailable).toEqual(["provider did not negotiate Goal"])
  })

  test("does not re-read when capabilities are already known", async () => {
    let refreshes = 0
    const { controller, armed } = mountController({
      capabilities: () => available,
      refreshGoal: async () => { refreshes += 1; return true },
    })

    await controller.arm()

    expect(refreshes).toBe(0)
    expect(armed()).toBe(true)
  })

  test("a failing on-demand read still reports unavailable instead of throwing", async () => {
    const { controller, armed, unavailable } = mountController({
      capabilities: () => undefined,
      refreshGoal: async () => { throw new Error("relay unavailable") },
    })

    await controller.arm()

    expect(armed()).toBe(false)
    expect(unavailable).toEqual([undefined])
  })

  test("entry points stay selectable while an existing session's capabilities are unknown", () => {
    // The `/goal` slash item and the toolbar Goal action gate on `selectable`.
    // Existing sessions hydrate Goal capabilities DEFERRED, so unknown must
    // count as selectable — gating on `available` left `/goal` permanently
    // disabled in every existing session while new sessions (eager draft
    // capabilities) worked.
    const { controller } = mountController({ capabilities: () => undefined })
    expect(controller.selectable()).toBe(true)
    expect(controller.available()).toBe(false)
  })

  test("entry points disable only once capabilities are KNOWN unavailable", () => {
    const { controller } = mountController({
      capabilities: () => ({
        implemented: true,
        available: false,
        unavailableReason: "provider did not negotiate Goal",
        actions: [],
        recovery: "blocked",
        optionalFields: [],
      }),
    })
    expect(controller.selectable()).toBe(false)
  })

  test("entry points are selectable when capabilities are known available", () => {
    const { controller } = mountController({ capabilities: () => available })
    expect(controller.selectable()).toBe(true)
  })
})
