import { createRoot, createSignal, createMemo } from "solid-js"
import { afterEach, describe, expect, test, vi } from "vitest"
import { createComposerPermissionModeWiring } from "./permission-mode-wiring"
import { markFastSessionSwitch } from "@/platform/runtime/session-switch"

// createResource compares its source with `===`, so the resource key here is
// a value-stable serialized string: an upstream signal wobble that resolves
// to the same (session, directory, harness) must not trigger a refetch.
const fetchModes = vi.hoisted(() =>
  vi.fn(async () => ({ data: { modes: [], appliesFrom: "next-turn" as const } })),
)
const setMode = vi.hoisted(() => vi.fn(async () => ({ data: {} })))

vi.mock("@/features/session/store/session-transport", () => ({
  fetchSessionPermissionModesByTransport: fetchModes,
  setSessionPermissionModeByTransport: setMode,
}))

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function wiringHarness(input: { signed?: boolean } = {}) {
  const [wobble, setWobble] = createSignal(0)
  const [sessionId, setSessionId] = createSignal("ses_1")
  const [harness, setHarness] = createSignal<string | undefined>("opencode")
  const dispose: VoidFunction[] = []
  const wiring = createRoot((d) => {
    dispose.push(d)
    return createComposerPermissionModeWiring({
      sessionId: () => {
        wobble()
        return sessionId()
      },
      directory: () => "/repo",
      harness,
      harnessSelection: () => {
        const connectionId = harness()
        return connectionId ? { kind: "connection", connectionId } : undefined
      },
      claxedoServerUrl: () => "http://127.0.0.1:3001",
      signedControlPlane: () => input.signed !== false,
      workspace: () => input.signed === false ? undefined : ({ workspaceId: "ws_signed", kind: "machine" }),
      sessionRef: () => input.signed === false
        ? ({ sessionId: "ses_1", host: "workspace", cwd: "/repo", toolSandbox: { kind: "local", cwd: "/repo" } })
        : ({ sessionId: "ses_1", host: "workspace", workspaceId: "ws_signed", toolSandbox: { kind: "workspace", workspaceId: "ws_signed", hosting: "machine" } }),
      requestFailedTitle: () => "failed",
    })
  })
  const mode = createRoot((d) => { dispose.push(d); return createMemo(() => wiring.report()?.currentModeId) })
  return { wiring, mode, setWobble, setSessionId, setHarness, dispose: () => dispose.forEach((d) => d()) }
}

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as typeof globalThis & { __claxedoFastSessionSwitch?: unknown }).__claxedoFastSessionSwitch
  delete (globalThis as typeof globalThis & { window?: { __claxedoFastSessionSwitch?: unknown } }).window
    ?.__claxedoFastSessionSwitch
})

describe("permission-mode wiring resource key", () => {
  test("never carries one session's current mode into another session", async () => {
    const report = { modes: [], appliesFrom: "next-turn" as const, currentModeId: "agent" }
    fetchModes.mockResolvedValueOnce({ data: report })
    fetchModes.mockImplementationOnce(() => new Promise(() => {}))
    const { wiring, setSessionId, dispose } = wiringHarness()
    await flush()
    expect(wiring.report()?.currentModeId).toBe("agent")
    setSessionId("ses_other")
    expect(wiring.report()).toBeUndefined()
    dispose()
  })

  test("keeps the accepted mode visible while confirmation is pending", async () => {
    const old = { modes: [], appliesFrom: "next-turn" as const, currentModeId: "agent" }
    const accepted = { ...old, currentModeId: "read-only" }
    fetchModes.mockResolvedValueOnce({ data: old })
    fetchModes.mockImplementationOnce(() => new Promise(() => {}))
    setMode.mockResolvedValueOnce({ data: accepted })
    const { wiring, mode, dispose } = wiringHarness()
    await flush()
    expect(mode()).toBe("agent")
    await wiring.writer().setPermissionMode!({ sessionID: "ses_1", modeId: "read-only" })
    expect(mode()).toBe("read-only")
    dispose()
  })

  test("cancels the quiet-window read when its owner is disposed", async () => {
    vi.useFakeTimers()
    fetchModes.mockClear()
    markFastSessionSwitch("ses_1", Date.now())
    const { dispose } = wiringHarness()
    await Promise.resolve()

    expect(fetchModes).not.toHaveBeenCalled()
    dispose()
    await vi.advanceTimersByTimeAsync(2_100)
    expect(fetchModes).not.toHaveBeenCalled()
  })

  test("publishes only the newest key after the quiet window", async () => {
    vi.useFakeTimers()
    fetchModes.mockClear()
    markFastSessionSwitch("ses_1", Date.now())
    const { setHarness, dispose } = wiringHarness()
    await Promise.resolve()

    setHarness("codex-acp")
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(fetchModes).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await Promise.resolve()
    expect(fetchModes).toHaveBeenCalledTimes(1)
    expect(fetchModes.mock.calls[0]?.[0]).toMatchObject({ harness: { kind: "connection", connectionId: "codex-acp" } })
    dispose()
  })

  test("upstream signal wobbles with identical values do not refetch", async () => {
    fetchModes.mockClear()
    const { setWobble, dispose } = wiringHarness()
    await flush()
    expect(fetchModes).toHaveBeenCalledTimes(1)

    setWobble(1)
    setWobble(2)
    await flush()
    expect(fetchModes).toHaveBeenCalledTimes(1)
    dispose()
  })

  test("a real harness change still refetches with the new harness in the request", async () => {
    fetchModes.mockClear()
    const { setHarness, dispose } = wiringHarness()
    await flush()
    expect(fetchModes).toHaveBeenCalledTimes(1)
    expect(fetchModes.mock.calls[0]?.[0]).toMatchObject({ harness: { kind: "connection", connectionId: "opencode" } })

    setHarness("codex-acp")
    await flush()
    expect(fetchModes).toHaveBeenCalledTimes(2)
    expect(fetchModes.mock.calls[1]?.[0]).toMatchObject({ harness: { kind: "connection", connectionId: "codex-acp" } })
    dispose()
  })

  test("local permission mode reads carry the session ref but no workspace scope", async () => {
    fetchModes.mockClear()
    setMode.mockClear()
    const { wiring, dispose } = wiringHarness({ signed: false })
    await flush()
    await wiring.writer().setPermissionMode({ sessionID: "ses_1", modeId: "auto" })
    for (const call of [fetchModes.mock.calls[0]?.[0], setMode.mock.calls[0]?.[0]]) {
      expect(call).toMatchObject({ signedControlPlane: false })
      expect(call).not.toHaveProperty("workspaceId")
      expect(call).not.toHaveProperty("hostKind")
      // The ref's local tool sandbox is what places the request on the loopback
      // runtime; without it a draft has nothing to route by and the fetch throws.
      expect(call).toMatchObject({ sessionRef: { toolSandbox: { kind: "local", cwd: "/repo" } } })
    }
    dispose()
  })

  test("a local draft asks for the harness's modes with its session ref", async () => {
    fetchModes.mockClear()
    const { setSessionId, dispose } = wiringHarness({ signed: false })
    setSessionId("")
    await flush()
    const draftCall = fetchModes.mock.calls.find((call) => call[0]?.sessionID === "")?.[0]
    expect(draftCall).toMatchObject({
      sessionID: "",
      harness: { kind: "connection", connectionId: "opencode" },
      sessionRef: { toolSandbox: { kind: "local", cwd: "/repo" } },
    })
    dispose()
  })

  test("an explicit refetch (mode write reconciliation) still asks the runtime again", async () => {
    fetchModes.mockClear()
    setMode.mockClear()
    const { wiring, dispose } = wiringHarness()
    await flush()
    expect(fetchModes).toHaveBeenCalledTimes(1)

    await wiring.writer().setPermissionMode({ sessionID: "ses_1", modeId: "auto" })
    await flush()
    expect(fetchModes).toHaveBeenCalledTimes(2)
    const scope = {
      claxedoServerUrl: "http://127.0.0.1:3001",
      signedControlPlane: true,
      workspaceId: "ws_signed",
      hostKind: "machine",
    }
    expect(fetchModes.mock.calls[0]?.[0]).toMatchObject(scope)
    expect(setMode.mock.calls[0]?.[0]).toMatchObject(scope)
    expect(fetchModes.mock.calls[0]?.[0]).toMatchObject({
      sessionRef: {
        sessionId: "ses_1",
        workspaceId: "ws_signed",
        toolSandbox: { kind: "workspace", hosting: "machine" },
      },
    })
    expect(setMode.mock.calls[0]?.[0]).toMatchObject({
      sessionRef: {
        sessionId: "ses_1",
        workspaceId: "ws_signed",
        toolSandbox: { kind: "workspace", hosting: "machine" },
      },
    })
    dispose()
  })
})
