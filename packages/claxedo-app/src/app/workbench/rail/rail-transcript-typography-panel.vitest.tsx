import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { Show, createSignal } from "solid-js"

vi.mock("@/platform/auth/auth-session", () => ({
  useAuthSession: () => ({
    status: () => "signed",
    user: () => ({ fullName: "Yash Rathore" }),
    signIn: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
  }),
}))

vi.mock("@/platform/account/account-provider", () => ({
  useAccountPort: () => ({
    state: () => ({ status: "signed", identity: { userId: "user_1", displayName: "Yash Rathore" } }),
    signIn: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    run: vi.fn(async () => undefined),
  }),
}))

vi.mock("@/app/providers/config", () => ({
  useConfigOptional: () => ({ authEnabled: true, accountSignInEnabled: false, sandboxEnabled: false }),
}))

vi.mock("@/platform/runtime/platform-provider", () => ({
  usePlatform: () => ({ platform: "web" }),
}))

vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

const { SettingsProvider, useSettings } = await import("@/platform/settings/provider")
const { removePersisted } = await import("@/platform/persistence/persist")
const { RailAccountMenu } = await import("./rail-account-menu")
const { RailTranscriptTypographyMenuItem, RailTranscriptTypographyPanel } = await import("./rail-transcript-typography-panel")

let port!: ReturnType<typeof useSettings>["appearance"]
function AppearancePort() {
  port = useSettings().appearance
  return null
}

const lock = vi.fn()

/** The rail's own wiring in miniature: the account-menu row toggles the panel, the panel's dropdowns lock the rail. */
function Rail() {
  const [open, setOpen] = createSignal(false)
  return (
    <>
      <Show when={open()}>
        <RailTranscriptTypographyPanel onClose={() => setOpen(false)} onMenuOpenChange={lock} />
      </Show>
      <RailAccountMenu
        onRailLockChange={() => {}}
        utilities={() => <RailTranscriptTypographyMenuItem open={open()} onToggle={() => setOpen((value) => !value)} />}
      />
    </>
  )
}

function mount() {
  render(() => (
    <SettingsProvider>
      <AppearancePort />
      <Rail />
    </SettingsProvider>
  ))
}

const trigger = (action: string) => document.querySelector<HTMLElement>(`[data-action="${action}"]`)
const panel = () => document.querySelector('[data-component="transcript-typography-panel"]')

/** jsdom never fires animationend, so a closed menu's DOM lingers with `data-closed`; only the live one counts. */
const menuRow = () => document.querySelector<HTMLElement>('[role="menu"]:not([data-closed]) [data-action="settings-transcript-menu"]')

async function openAccountMenu() {
  fireEvent.keyDown(screen.getByTestId("rail-account-trigger"), { key: "ArrowDown" })
  await waitFor(() => expect(screen.getByTestId("rail-account-trigger")).toHaveAttribute("aria-expanded", "true"))
}

async function openPanel() {
  mount()
  await openAccountMenu()
  fireEvent.keyDown(menuRow()!, { key: "Enter" })
  await waitFor(() => expect(panel()).toBeTruthy())
}

/** jsdom has no PointerEvent, so the trigger's pointerdown path never sees `button`; ArrowDown opens it too. */
async function openChoices(action: string) {
  const row = trigger(action)!
  fireEvent.keyDown(row, { key: "ArrowDown" })
  await waitFor(() => expect(row).toHaveAttribute("aria-expanded", "true"))
}

async function pick(action: string, label: string) {
  await openChoices(action)
  fireEvent.keyDown(await screen.findByRole("menuitemradio", { name: label }), { key: "Enter" })
}

afterEach(() => {
  cleanup()
  lock.mockClear()
  removePersisted({ key: "settings.v3" })
})

describe("RailTranscriptTypographyPanel (dev-only knob)", () => {
  test("neither the menu row nor the panel exists outside a dev build", async () => {
    vi.stubEnv("DEV", false)
    try {
      mount()
      await openAccountMenu()
      expect(menuRow()).toBeNull()
      expect(panel()).toBeNull()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  test("the account-menu row shows the panel inside the rail and, once it is open, hides it again", async () => {
    await openPanel()
    expect(trigger("settings-transcript-pairing")).toBeTruthy()

    await openAccountMenu()
    expect(menuRow()).toHaveTextContent("✓")
    fireEvent.keyDown(menuRow()!, { key: "Enter" })
    await waitFor(() => expect(panel()).toBeNull())
  })

  test("the close button hides the panel", async () => {
    await openPanel()
    fireEvent.click(trigger("settings-transcript-close")!)
    await waitFor(() => expect(panel()).toBeNull())
  })

  test("each row shows the stored answer beside its label: the pairing by name, an absent override as follow-pairing", async () => {
    await openPanel()
    port.setTranscriptPairing("editorial")
    port.setTranscriptOverride({ mono: "menlo", fontSize: 16, codeFontSize: 14, headingScale: "clear", inlineCode: "tint", bodyWeight: 430 })

    await waitFor(() => expect(trigger("settings-transcript-pairing")).toHaveTextContent("Editorial"))
    expect(trigger("settings-transcript-body-face")).toHaveTextContent("Follow pairing")
    expect(trigger("settings-transcript-mono-face")).toHaveTextContent("Menlo")
    expect(trigger("settings-transcript-font-size")).toHaveTextContent("16 px")
    expect(trigger("settings-transcript-line-height")).toHaveTextContent("Follow pairing")
    expect(trigger("settings-transcript-code-font-size")).toHaveTextContent("14 px")
    expect(trigger("settings-transcript-heading-scale")).toHaveTextContent("Clear")
    expect(trigger("settings-transcript-measure")).toHaveTextContent("Follow pairing")
    expect(trigger("settings-transcript-inline-code")).toHaveTextContent("Tint, no ring")
    expect(trigger("settings-transcript-body-weight")).toHaveTextContent("430")
    expect(trigger("settings-transcript-prose-color")).toHaveTextContent("Follow pairing")
  })

  test("picking a body face writes that override, leaves the pairing alone and keeps the choices open", async () => {
    await openPanel()
    port.setTranscriptPairing("quiet")
    await waitFor(() => expect(trigger("settings-transcript-pairing")).toHaveTextContent("Quiet"))

    await pick("settings-transcript-body-face", "Charter")

    await waitFor(() => expect(port.transcript()).toEqual({ pairing: "quiet", body: "charter" }))
    expect(trigger("settings-transcript-body-face")).toHaveTextContent("Charter")
    expect(trigger("settings-transcript-body-face")).toHaveAttribute("aria-expanded", "true")
  })

  test("a row's choices lock the rail open while they show and release it when they close", async () => {
    await openPanel()
    await openChoices("settings-transcript-font-size")
    expect(lock).toHaveBeenLastCalledWith(true)

    fireEvent.keyDown(await screen.findByRole("menuitemradio", { name: "15.5 px" }), { key: "Escape" })
    await waitFor(() => expect(lock).toHaveBeenLastCalledWith(false))
  })

  test("with no stored pairing the row reads as the theme's and names what that resolves to", async () => {
    await openPanel()
    expect(trigger("settings-transcript-pairing")).toHaveTextContent("Theme · Default")
  })

  test("a numeric row writes a number over the theme's pairing and 'follow pairing' clears it", async () => {
    await openPanel()

    await pick("settings-transcript-font-size", "15.5 px")
    await waitFor(() => expect(port.transcript()).toEqual({ fontSize: 15.5 }))

    await pick("settings-transcript-font-size", "Follow pairing")
    await waitFor(() => expect(port.transcript()).toEqual({}))
  })

  test("an enumerated row writes the knob's own type and 'follow pairing' clears it", async () => {
    await openPanel()

    await pick("settings-transcript-rules", "1px hairline")
    await waitFor(() => expect(port.transcript()).toEqual({ rules: "visible" }))

    await pick("settings-transcript-rules", "Follow pairing")
    await waitFor(() => expect(port.transcript()).toEqual({}))
  })

  test("picking a pairing drops every override; picking the theme's drops the pairing too", async () => {
    await openPanel()
    port.setTranscriptOverride({ heading: "newyork", lineHeight: 1.7 })
    await waitFor(() => expect(trigger("settings-transcript-line-height")).toHaveTextContent("1.7"))

    await pick("settings-transcript-pairing", "Swiss")

    await waitFor(() => expect(port.transcript()).toEqual({ pairing: "swiss" }))
    expect(trigger("settings-transcript-heading-face")).toHaveTextContent("Follow pairing")

    await pick("settings-transcript-pairing", "Theme's")
    await waitFor(() => expect(port.transcript()).toEqual({}))
  })

  test("the reset button returns to the theme's pairing with no overrides and disables itself there", async () => {
    await openPanel()
    const reset = () => trigger("settings-transcript-reset") as HTMLButtonElement
    expect(reset().disabled).toBe(true)

    port.setTranscriptPairing("classic")
    port.setTranscriptOverride({ measure: 64 })
    await waitFor(() => expect(reset().disabled).toBe(false))

    fireEvent.click(reset())

    await waitFor(() => expect(port.transcript()).toEqual({}))
    expect(reset().disabled).toBe(true)
  })
})
