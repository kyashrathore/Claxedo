import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const state = vi.hoisted(() => ({
  authEnabled: true,
  sandboxEnabled: false,
  platform: "web" as "web" | "desktop",
  status: "signed" as "loading" | "anonymous" | "signed",
  user: {} as Record<string, unknown>,
  signIn: vi.fn(async () => undefined),
  signOut: vi.fn(async () => undefined),
}))

vi.mock("@/platform/auth/auth-session", () => ({
  useAuthSession: () => ({
    status: () => state.status,
    user: () => state.user,
    signIn: state.signIn,
    signOut: state.signOut,
  }),
}))

vi.mock("@/app/providers/config", () => ({
  useConfigOptional: () => ({ authEnabled: state.authEnabled, sandboxEnabled: state.sandboxEnabled }),
}))

vi.mock("@claxedo/app", () => ({
  usePlatform: () => ({ platform: state.platform }),
  useLanguage: () => ({
    t: (key: string) => ({
      "sidebar.settings": "Settings",
      "sidebar.help": "Help",
      "settings.general.section.account": "Account",
      "settings.general.account.logout.button": "Log out",
    })[key] ?? key,
  }),
}))

import { RailAccountMenu } from "./rail-account-menu"

beforeEach(() => {
  window.scrollTo = vi.fn()
  state.authEnabled = true
  state.sandboxEnabled = false
  state.platform = "web"
  state.status = "signed"
  state.user = { fullName: "Yash Rathore", imageUrl: "https://example.test/avatar.png" }
  state.signIn.mockClear()
  state.signOut.mockClear()
})

afterEach(() => cleanup())

function renderMenu(input: Partial<Parameters<typeof RailAccountMenu>[0]> = {}) {
  const props = {
    onDiagnostics: vi.fn(),
    onHelp: vi.fn(),
    onRailLockChange: vi.fn(),
    onSettings: vi.fn(),
    ...input,
  }
  render(() => <RailAccountMenu {...props} />)
  return props
}

async function openMenu(name: string | RegExp = "Yash Rathore") {
  const trigger = screen.getByRole("button", { name })
  fireEvent.keyDown(trigger, { key: "ArrowDown" })
  await screen.findByRole("menu")
  return trigger
}

function selectMenuItem(name: string) {
  fireEvent.keyDown(screen.getByRole("menuitem", { name }), { key: "Enter" })
}

describe("RailAccountMenu", () => {
  test("renders signed identity and delegates signed-only logout", async () => {
    const props = renderMenu()
    const trigger = await openMenu()

    expect(trigger).toHaveAttribute("title", "Yash Rathore")
    expect(document.querySelector("[data-slot='avatar-image']")).toHaveAttribute("src", "https://example.test/avatar.png")
    expect(screen.queryByRole("menuitem", { name: "Sign in" })).toBeNull()
    selectMenuItem("Log out")

    await waitFor(() => expect(state.signOut).toHaveBeenCalledOnce())
    expect(props.onRailLockChange).toHaveBeenNthCalledWith(1, true)
    await waitFor(() => expect(props.onRailLockChange).toHaveBeenLastCalledWith(false))
  })

  test.each([
    [{ username: "yash" }, "yash"],
    [{ primaryEmailAddress: { emailAddress: "yash@example.com" } }, "yash@example.com"],
    [{ emailAddresses: [{ emailAddress: "fallback@example.com" }] }, "fallback@example.com"],
    [{}, "Account"],
  ])("uses the signed identity fallback order", (user, label) => {
    state.user = user
    renderMenu()

    const trigger = screen.getByRole("button", { name: label })
    expect(trigger.querySelector("[data-slot='rail-account-label']")).toHaveClass("truncate")
    expect(trigger).toHaveAttribute("title", label)
  })

  test("keeps signed identity when auth is disabled", async () => {
    state.authEnabled = false
    renderMenu()

    await openMenu()
    expect(screen.getByRole("menuitem", { name: "Log out" })).toBeInTheDocument()
    expect(screen.queryByText("Local workspace")).toBeNull()
  })

  test("shows Sign in only for auth-enabled anonymous mode", async () => {
    state.status = "anonymous"
    state.user = {}
    renderMenu()

    await openMenu("Sign in")
    selectMenuItem("Sign in")

    await waitFor(() => expect(state.signIn).toHaveBeenCalledWith({ redirectUrl: window.location.href }))
    expect(screen.queryByRole("menuitem", { name: "Log out" })).toBeNull()
  })

  test("shows Local workspace without auth commands when auth is disabled", async () => {
    state.status = "anonymous"
    state.authEnabled = false
    state.user = {}
    renderMenu()

    await openMenu("Local workspace")
    expect(screen.queryByRole("menuitem", { name: "Sign in" })).toBeNull()
    expect(screen.queryByRole("menuitem", { name: "Log out" })).toBeNull()
  })

  test("keeps non-auth actions available while auth is loading", async () => {
    state.status = "loading"
    state.user = {}
    // Diagnostics is desktop-only, so drive the desktop platform to exercise it.
    state.platform = "desktop"
    const props = renderMenu()

    await openMenu("Account")
    selectMenuItem("Diagnostics")

    expect(props.onDiagnostics).toHaveBeenCalledOnce()
    expect(screen.queryByRole("menuitem", { name: "Sign in" })).toBeNull()
    expect(screen.queryByRole("menuitem", { name: "Log out" })).toBeNull()
  })

  test("hides diagnostics in hosted cloud web and keeps it in the desktop app", async () => {
    state.sandboxEnabled = true
    renderMenu()

    await openMenu()
    expect(screen.queryByRole("menuitem", { name: "Diagnostics" })).toBeNull()

    cleanup()
    state.platform = "desktop"
    renderMenu()
    await openMenu()
    expect(screen.getByRole("menuitem", { name: "Diagnostics" })).toBeInTheDocument()
  })

  test("delegates settings and help actions", async () => {
    const props = renderMenu()
    await openMenu()
    selectMenuItem("Settings")
    expect(props.onSettings).toHaveBeenCalledOnce()

    cleanup()
    renderMenu({ onHelp: props.onHelp })
    await openMenu()
    selectMenuItem("Help")
    expect(props.onHelp).toHaveBeenCalledOnce()
  })
})
