import { createRoot, createSignal } from "solid-js"
import { describe, expect, test, vi } from "vitest"
import { createComposerPermissionModeWiring } from "./permission-mode-wiring"

// Falsifier for the boot request graph's 3x GET /permission-mode: the
// wiring's resource source used to be a fresh object literal, so ANY upstream
// signal wobble refetched even when the resolved (session, directory, harness)
// values were identical. The source is now a value-stable string. Verified
// red on the old wiring: the first test observed one fetch per wobble.
const fetchModes = vi.hoisted(() =>
  vi.fn(async () => ({ data: { modes: [], appliesFrom: "next-turn" as const } })),
)

vi.mock("@/features/session/store/session-transport", () => ({
  fetchSessionPermissionModesByTransport: fetchModes,
  setSessionPermissionModeByTransport: vi.fn(async () => ({ data: {} })),
}))

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function wiringHarness() {
  const [wobble, setWobble] = createSignal(0)
  const [harness, setHarness] = createSignal<string | undefined>("opencode")
  const dispose: VoidFunction[] = []
  const wiring = createRoot((d) => {
    dispose.push(d)
    return createComposerPermissionModeWiring({
      sessionId: () => {
        wobble()
        return "ses_1"
      },
      directory: () => "/repo",
      harness,
      client: {} as never,
      requestFailedTitle: () => "failed",
    })
  })
  return { wiring, setWobble, setHarness, dispose: () => dispose.forEach((d) => d()) }
}

describe("permission-mode wiring resource key", () => {
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

  test("an explicit refetch (mode write reconciliation) still asks the runtime again", async () => {
    fetchModes.mockClear()
    const { wiring, dispose } = wiringHarness()
    await flush()
    expect(fetchModes).toHaveBeenCalledTimes(1)

    await wiring.writer().setPermissionMode({ sessionID: "ses_1", modeId: "auto" })
    await flush()
    expect(fetchModes).toHaveBeenCalledTimes(2)
    dispose()
  })
})
