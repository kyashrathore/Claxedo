import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { createSignal } from "solid-js"
import type { AccountPort, AccountState } from "@/platform/account/account-port"
import { AccountPortProvider } from "@/platform/account/account-provider"
import { AccountSettingsSection } from "./account-section"

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

function mount(port: AccountPort) {
  return render(() => (
    <AccountPortProvider port={port}>
      <AccountSettingsSection t={(key) => key} />
    </AccountPortProvider>
  ))
}

afterEach(() => {
  cleanup()
  navigate.mockClear()
})

describe("AccountSettingsSection", () => {
  test("shows the signed identity and how it was proved", () => {
    mount(
      stubPort({
        status: "signed",
        identity: { userId: "user_1", email: "person@example.com", displayName: "A Person", method: "Google" },
      }),
    )

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
    const signOut = vi.fn(async () => {
      order.push("signOut")
    })
    navigate.mockImplementation(() => order.push("navigate"))
    mount(stubPort({ status: "signed", identity: { userId: "user_1", email: "person@example.com" } }, signOut))

    fireEvent.click(screen.getByText("settings.general.account.logout.button"))

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/login", { replace: true }))
    expect(order).toEqual(["signOut", "navigate"])
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
    // A plain signal, so the new state is the RETURN value. A mutating updater
    // (`(state) => { Object.assign(state, ...) }`) is the store-write shape:
    // here it returns undefined, which is what the signal becomes, and the
    // section then renders nothing at all.
    setState({
      status: "signed",
      identity: { userId: "user_1", email: "later@example.com", method: "Google" },
    })

    await waitFor(() => expect(screen.getByText("later@example.com")).toBeTruthy())
  })
})
