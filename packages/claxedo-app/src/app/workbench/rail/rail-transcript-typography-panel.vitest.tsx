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
  useConfigOptional: () => ({ accountSignInEnabled: false, sandboxEnabled: false }),
}))

vi.mock("@/app/connection/deployment-posture", () => ({
  useDeploymentPosture: () => ({ issuesSessions: () => true }),
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

/** The rail's own wiring in miniature: the account-menu row toggles the panel. */
function Rail() {
  const [open, setOpen] = createSignal(false)
  return (
    <>
      <Show when={open()}>
        <RailTranscriptTypographyPanel onClose={() => setOpen(false)} />
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
/** The account menu's modal layer aria-hides the rail while its closed DOM lingers, so rows are read by action, not role. */
const row = (pairing: string) => trigger(`settings-transcript-pairing-${pairing}`)!

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

afterEach(() => {
  cleanup()
  removePersisted({ key: "settings.v3" })
})

describe("RailTranscriptTypographyPanel (dev-only preset picker)", () => {
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
    expect(trigger("settings-transcript-pairing-theme")).toBeTruthy()

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

  test("with no stored pairing the theme's row is checked and names what that resolves to", async () => {
    await openPanel()
    expect(row("theme")).toHaveAttribute("aria-checked", "true")
    expect(row("theme")).toHaveTextContent("Default")
    expect(row("codex")).toHaveAttribute("aria-checked", "false")
  })

  test("picking a pairing stores it and moves the check; picking the theme's clears it", async () => {
    await openPanel()

    fireEvent.click(row("codex"))
    await waitFor(() => expect(port.transcript()).toEqual({ pairing: "codex" }))
    expect(row("codex")).toHaveAttribute("aria-checked", "true")
    expect(row("theme")).toHaveAttribute("aria-checked", "false")

    fireEvent.click(row("editorial"))
    await waitFor(() => expect(port.transcript()).toEqual({ pairing: "editorial" }))

    fireEvent.click(row("theme"))
    await waitFor(() => expect(port.transcript()).toEqual({}))
    expect(row("theme")).toHaveAttribute("aria-checked", "true")
  })

  test("a stored pairing from before the panel opened is the checked row", async () => {
    mount()
    port.setTranscriptPairing("swiss")
    await openAccountMenu()
    fireEvent.keyDown(menuRow()!, { key: "Enter" })
    await waitFor(() => expect(panel()).toBeTruthy())
    expect(row("swiss")).toHaveAttribute("aria-checked", "true")
  })
})
