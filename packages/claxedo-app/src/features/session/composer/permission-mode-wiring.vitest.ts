import { createRoot, createSignal } from "solid-js"
import { afterEach, describe, expect, test, vi } from "vitest"
import { createComposerPermissionModeWiring } from "./permission-mode-wiring"
import { markFastSessionSwitch } from "@/platform/runtime/session-switch"

// Falsifier for the boot request graph's 3x GET /permission-mode: the
// wiring's resource source used to be a fresh object literal, so ANY upstream
// signal wobble refetched even when the resolved (session, directory, harness)
// values were identical. The source is now a value-stable string. Verified
// red on the old wiring: the first test observed one fetch per wobble.
const fetchModes = vi.hoisted(() => vi.fn(async () => ({ data: { modes: [], appliesFrom: "next-turn" as const } })))
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
      client: {} as never,
      claxedoServerUrl: () => "http://127.0.0.1:3001",
      signedControlPlane: () => input.signed !== false,
      workspace: () => (input.signed === false ? undefined : { workspaceId: "ws_signed", kind: "user-hosted" }),
      sessionRef: () =>
        input.signed === false
          ? { sessionId: "ses_1", host: "workspace", cwd: "/repo", toolSandbox: { kind: "local", cwd: "/repo" } }
          : {
              sessionId: "ses_1",
              host: "workspace",
              workspaceId: "ws_signed",
              toolSandbox: { kind: "workspace", workspaceId: "ws_signed", hosting: "user-hosted" },
            },
      requestFailedTitle: () => "failed",
    })
  })
  return { wiring, setWobble, setSessionId, setHarness, dispose: () => dispose.forEach((d) => d()) }
}

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as typeof globalThis & { __claxedoFastSessionSwitch?: unknown }).__claxedoFastSessionSwitch
  delete (globalThis as typeof globalThis & { window?: { __claxedoFastSessionSwitch?: unknown } }).window
    ?.__claxedoFastSessionSwitch
})

describe("permission-mode wiring resource key", () => {
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
    expect(fetchModes.mock.calls[0]?.[0]).toMatchObject({ harness: "codex-acp" })
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
    expect(fetchModes.mock.calls[0]?.[0]).toMatchObject({ harness: "opencode" })

    setHarness("codex-acp")
    await flush()
    expect(fetchModes).toHaveBeenCalledTimes(2)
    expect(fetchModes.mock.calls[1]?.[0]).toMatchObject({ harness: "codex-acp" })
    dispose()
  })

  test("local permission mode reads omit signed transport scope", async () => {
    fetchModes.mockClear()
    setMode.mockClear()
    const { wiring, dispose } = wiringHarness({ signed: false })
    await flush()
    await wiring.writer().setPermissionMode({ sessionID: "ses_1", modeId: "auto" })
    for (const call of [fetchModes.mock.calls[0]?.[0], setMode.mock.calls[0]?.[0]]) {
      expect(call).not.toHaveProperty("signedControlPlane")
      expect(call).not.toHaveProperty("workspaceId")
      expect(call).not.toHaveProperty("sessionRef")
    }
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
      workspaceKind: "user-hosted",
    }
    expect(fetchModes.mock.calls[0]?.[0]).toMatchObject(scope)
    expect(setMode.mock.calls[0]?.[0]).toMatchObject(scope)
    expect(fetchModes.mock.calls[0]?.[0]).toMatchObject({
      sessionRef: {
        sessionId: "ses_1",
        workspaceId: "ws_signed",
        toolSandbox: { kind: "workspace", hosting: "user-hosted" },
      },
    })
    expect(setMode.mock.calls[0]?.[0]).toMatchObject({
      sessionRef: {
        sessionId: "ses_1",
        workspaceId: "ws_signed",
        toolSandbox: { kind: "workspace", hosting: "user-hosted" },
      },
    })
    dispose()
  })
})
