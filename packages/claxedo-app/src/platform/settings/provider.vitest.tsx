import { cleanup, render, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test } from "vitest"
import { removePersisted, setPersisted } from "@/platform/persistence/persist"
import { SettingsProvider, useSettings } from "./provider"

const TARGET = { key: "settings.v3" }

type Port = ReturnType<typeof useSettings>["appearance"]

let appearance!: Port

function SettingsPort() {
  appearance = useSettings().appearance
  return null
}

async function mount() {
  render(() => (
    <SettingsProvider>
      <SettingsPort />
    </SettingsProvider>
  ))
  await waitFor(() => expect(appearance).toBeTruthy())
}

const persisted = () => JSON.parse(localStorage.getItem(TARGET.key) ?? "{}") as { appearance?: { transcript?: unknown } }

// The persist layer keeps an in-memory copy that outlives `localStorage.clear()`.
afterEach(() => {
  cleanup()
  removePersisted(TARGET)
})

describe("appearance.transcript", () => {
  test("a fresh install follows the default pairing with no overrides", async () => {
    await mount()
    expect(appearance.transcript()).toEqual({ pairing: "default" })
  })

  test("choosing a pairing clears every override the previous pairing carried", async () => {
    await mount()
    appearance.setTranscriptPairing("editorial")
    appearance.setTranscriptOverride({ body: "palatino", mono: "menlo" })
    appearance.setTranscriptOverride({ fontSize: 17, lineHeight: 1.7 })
    await waitFor(() =>
      expect(appearance.transcript()).toEqual({
        pairing: "editorial",
        body: "palatino",
        mono: "menlo",
        fontSize: 17,
        lineHeight: 1.7,
      }),
    )

    appearance.setTranscriptPairing("swiss")

    await waitFor(() => expect(appearance.transcript()).toEqual({ pairing: "swiss" }))
    await waitFor(() => expect(persisted().appearance?.transcript).toEqual({ pairing: "swiss" }))
  })

  test("an override set back to follow-pairing is dropped rather than stored as undefined", async () => {
    await mount()
    appearance.setTranscriptOverride({ heading: "newyork" })
    await waitFor(() => expect(appearance.transcript().heading).toBe("newyork"))

    appearance.setTranscriptOverride({ heading: undefined })

    await waitFor(() => expect(appearance.transcript()).toEqual({ pairing: "default" }))
    await waitFor(() => expect(persisted().appearance?.transcript).toEqual({ pairing: "default" }))
  })

  test("a write from another tab reaches this tab's store", async () => {
    await mount()
    appearance.setTranscriptPairing("swiss")
    await waitFor(() => expect(appearance.transcript().pairing).toBe("swiss"))

    const foreign = JSON.parse(localStorage.getItem(TARGET.key) ?? "{}") as { appearance: Record<string, unknown> }
    foreign.appearance.transcript = { pairing: "quiet", measure: 64 }
    window.dispatchEvent(new StorageEvent("storage", { key: TARGET.key, newValue: JSON.stringify(foreign) }))

    await waitFor(() => expect(appearance.transcript()).toEqual({ pairing: "quiet", measure: 64 }))
  })

  test("a persisted record naming a retired pairing or face reads as the default", async () => {
    setPersisted(TARGET, {
      appearance: { transcript: { pairing: "gone", body: "comic", fontSize: 15, codeFontSize: 40, headingScale: "clear" } },
    })
    await mount()
    await waitFor(() =>
      expect(appearance.transcript()).toEqual({ pairing: "default", fontSize: 15, headingScale: "clear" }),
    )
  })
})
