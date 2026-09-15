import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { createSignal } from "solid-js"
import type { AccountPort, AccountState } from "@/platform/account/account-port"
import { AccountPortProvider } from "@/platform/account/account-provider"
import { AccountSettingsSection } from "./account-section"
import type { AgentSettingsApi } from "@/features/settings/data/agent-settings-api"

/**
 * The account surface, against a stubbed port.
 *
 * Written because this component had NO unit coverage while it read the auth
 * session directly — deleting its body failed nothing. It is now the first
 * surface bound to `AccountPort`, and on desktop it will render state that
 * arrived over IPC from a process this one holds no credential for. Whether it
 * still shows the right thing is exactly what has to keep being checked.
 */

const navigate = vi.fn()
vi.mock("@solidjs/router", () => ({ useNavigate: () => navigate }))

function stubPort(state: AccountState, signOut = vi.fn(async () => {})): AccountPort {
  return { state: () => state, signIn: vi.fn(async () => {}), signOut, run: vi.fn(async () => undefined as never) }
}

/** The control plane's agent setting, remembered so a write is read back by the next read. */
function agentSettings(initial = false): AgentSettingsApi & { writes: boolean[] } {
  let stored = initial
  const writes: boolean[] = []
  return {
    writes,
    read: async () => ({ crossMachineWrites: stored }),
    write: async (settings) => {
      writes.push(settings.crossMachineWrites)
      stored = settings.crossMachineWrites
      return settings
    },
  }
}

function mount(port: AccountPort, api: AgentSettingsApi = agentSettings()) {
  return render(() => (
    <AccountPortProvider port={port}>
      <AccountSettingsSection t={(key) => key} agentSettings={api} />
    </AccountPortProvider>
  ))
}

const signed: AccountState = {
  status: "signed",
  identity: { userId: "user_1", email: "person@example.com", displayName: "A Person", method: "Google" },
}

afterEach(() => {
  cleanup()
  navigate.mockReset()
})

describe("AccountSettingsSection", () => {
  test("shows the signed identity and how it was proved", () => {
    mount(stubPort({
      status: "signed",
      identity: { userId: "user_1", email: "person@example.com", displayName: "A Person", method: "Google" },
    }))

    expect(screen.getByText("person@example.com")).toBeTruthy()
    expect(screen.getByText("Signed in via Google")).toBeTruthy()
  })

  test("falls back to the display name when there is no email", () => {
    mount(stubPort({ status: "signed", identity: { userId: "user_1", displayName: "A Person", method: "Google" } }))

    expect(screen.getByText("A Person")).toBeTruthy()
  })

  test("shows no identity row while unsigned", () => {
    // Not a cosmetic detail: rendering an empty identity row would claim the
    // user is signed in when they are not.
    mount(stubPort({ status: "unsigned" }))

    expect(screen.queryByText(/Signed in via/)).toBeNull()
    expect(screen.getByText("settings.general.account.logout.title")).toBeTruthy()
  })

  test("shows no identity row while sign-in is still settling", () => {
    // `pending` is the desktop's real first frame — the system browser is open
    // and main has not answered yet.
    mount(stubPort({ status: "pending" }))

    expect(screen.queryByText(/Signed in via/)).toBeNull()
  })

  test("signs out through the port, and only then leaves for login", async () => {
    // Ordering matters, so it is recorded rather than inferred from two
    // independent `toHaveBeenCalled` assertions, which pass either way.
    // Navigating first would unmount this surface mid-flight and, on desktop,
    // abandon the IPC call that actually clears the credential.
    const order: string[] = []
    let finishSignOut!: () => void
    const pendingSignOut = new Promise<void>((resolve) => { finishSignOut = resolve })
    const signOut = vi.fn(async () => {
      order.push("signOut")
      await pendingSignOut
      order.push("signedOut")
    })
    navigate.mockImplementation(() => order.push("navigate"))
    mount(stubPort({ status: "signed", identity: { userId: "user_1", email: "person@example.com" } }, signOut))

    fireEvent.click(screen.getByText("settings.general.account.logout.button"))

    expect(signOut).toHaveBeenCalledOnce()
    await Promise.resolve()
    expect(navigate).not.toHaveBeenCalled()
    finishSignOut()
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/login", { replace: true }))
    expect(order).toEqual(["signOut", "signedOut", "navigate"])
  })

  test("shows agents acting on other machines as off until the control plane says otherwise", async () => {
    mount(stubPort(signed))

    const control = await screen.findByRole("switch", { name: "settings.general.account.agents.title" })
    expect(screen.getByText("settings.general.account.agents.description")).toBeTruthy()
    await waitFor(() => expect(control.getAttribute("aria-disabled")).toBeNull())
    expect(control.getAttribute("aria-checked")).toBe("false")
  })

  test("turning it on writes the account's setting and shows what the control plane stored", async () => {
    const api = agentSettings(false)
    mount(stubPort(signed), api)

    const control = await screen.findByRole("switch", { name: "settings.general.account.agents.title" })
    await waitFor(() => expect(control.getAttribute("aria-disabled")).toBeNull())
    fireEvent.click(control)

    await waitFor(() => expect(api.writes).toEqual([true]))
    await waitFor(() => expect(control.getAttribute("aria-checked")).toBe("true"))
  })

  test("a setting the control plane holds on is shown on", async () => {
    mount(stubPort(signed), agentSettings(true))

    const control = await screen.findByRole("switch", { name: "settings.general.account.agents.title" })
    await waitFor(() => expect(control.getAttribute("aria-checked")).toBe("true"))
  })

  test("a setting that cannot be read is said to be unavailable, and the switch cannot be flipped", async () => {
    const writes: boolean[] = []
    mount(stubPort(signed), {
      read: async () => {
        throw new Error("Agent settings are unavailable")
      },
      write: async (settings) => {
        writes.push(settings.crossMachineWrites)
        return settings
      },
    })

    expect(await screen.findByRole("alert")).toHaveTextContent("Agent settings are unavailable")
    const control = screen.getByRole("switch", { name: "settings.general.account.agents.title" })
    expect(control.getAttribute("aria-disabled")).toBe("true")
    fireEvent.click(control)
    await Promise.resolve()
    expect(writes).toEqual([])
  })

  test("a refused write keeps the switch where the control plane left it and says why", async () => {
    mount(stubPort(signed), {
      read: async () => ({ crossMachineWrites: false }),
      write: async () => {
        throw new Error("Canonical application identity is required")
      },
    })

    const control = await screen.findByRole("switch", { name: "settings.general.account.agents.title" })
    await waitFor(() => expect(control.getAttribute("aria-disabled")).toBeNull())
    fireEvent.click(control)

    expect(await screen.findByRole("alert")).toHaveTextContent("Canonical application identity is required")
    expect(control.getAttribute("aria-checked")).toBe("false")
  })

  test("reads the account reactively, not once at mount", async () => {
    // The port hands back a fresh state on every call precisely so a Solid memo
    // over it tracks. A binding that snapshotted `state()` at mount would pass
    // every test above and never update after sign-in.
    const [state, setState] = createSignal<AccountState>({ status: "unsigned" })
    const port: AccountPort = {
      state,
      signIn: async () => {},
      signOut: async () => {},
      run: async () => undefined as never,
    }
    mount(port)

    expect(screen.queryByText(/Signed in via/)).toBeNull()
    setState({ status: "signed", identity: { userId: "user_1", email: "later@example.com", method: "Google" } })

    await waitFor(() => expect(screen.getByText("later@example.com")).toBeTruthy())
  })
})
