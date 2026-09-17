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

describe("appearance fonts on <html>", () => {
  test("no chosen font leaves the theme's sans and mono tokens alone; a chosen one is written inline and cleared again", async () => {
    await mount()
    const root = document.documentElement.style
    await waitFor(() => expect(appearance).toBeTruthy())
    expect(root.getPropertyValue("--font-family-sans")).toBe("")
    expect(root.getPropertyValue("--font-family-mono")).toBe("")

    appearance.setUIFont("Inter")
    await waitFor(() => expect(root.getPropertyValue("--font-family-sans")).toMatch(/^Inter, /))
    expect(root.getPropertyValue("--font-family-mono")).toBe("")

    appearance.setUIFont("  ")
    await waitFor(() => expect(root.getPropertyValue("--font-family-sans")).toBe(""))
  })
})

describe("appearance.transcript", () => {
  test("a fresh install stores no pairing, which is 'the theme's'", async () => {
    await mount()
    expect(appearance.transcript()).toEqual({})
  })

  test("returning to the theme's pairing drops the stored pairing and every override", async () => {
    await mount()
    appearance.setTranscriptPairing("editorial")
    appearance.setTranscriptOverride({ fontSize: 17 })
    await waitFor(() => expect(appearance.transcript()).toEqual({ pairing: "editorial", fontSize: 17 }))

    appearance.setTranscriptPairing(undefined)

    await waitFor(() => expect(appearance.transcript()).toEqual({}))
    await waitFor(() => expect(persisted().appearance?.transcript).toEqual({}))
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

    await waitFor(() => expect(appearance.transcript()).toEqual({}))
    await waitFor(() => expect(persisted().appearance?.transcript).toEqual({}))
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

  test("a persisted record naming a retired pairing or face keeps only what still resolves", async () => {
    setPersisted(TARGET, {
      appearance: { transcript: { pairing: "gone", body: "comic", fontSize: 15, codeFontSize: 40, headingScale: "clear" } },
    })
    await mount()
    await waitFor(() => expect(appearance.transcript()).toEqual({ fontSize: 15, headingScale: "clear" }))
  })
})
