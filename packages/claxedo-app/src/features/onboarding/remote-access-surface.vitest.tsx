import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { RemoteAccessSurface, type RemoteAccessSurfaceProps } from "./remote-access-surface"

vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn(async () => "data:image/png;base64,qr") } }))

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard")
beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  cleanup()
  if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor)
  else Reflect.deleteProperty(navigator, "clipboard")
})

function mount(props: Partial<RemoteAccessSurfaceProps> = {}) {
  const merged: RemoteAccessSurfaceProps = {
    availability: { state: "enabled", proven: false },
    devices: [],
    startAtLogin: false,
    onStartAtLoginChange: () => undefined,
    onEnable: () => undefined,
    onSignIn: () => undefined,
    onRevoke: () => undefined,
    ...props,
  }
  render(() => <RemoteAccessSurface {...merged} />)
}

describe("before remote access is on", () => {
  test("renders blocker-honest locked copy and cannot enable", () => {
    mount({
      availability: {
        state: "locked",
        reason: "Remote access is coming soon. The hosted relay is not available yet.",
      },
    })

    expect(screen.getByText(/hosted relay is not available yet/i)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /enable remote access/i })).not.toBeInTheDocument()
  })

  test("offers one action, one machine-level promise, and startup survival", () => {
    const onStartAtLoginChange = vi.fn()
    const onEnable = vi.fn()
    mount({ availability: { state: "ready-to-enable" }, onStartAtLoginChange, onEnable })

    expect(screen.getByText(/reach every workspace on this machine from your other devices/i))
      .toBeInTheDocument()
    fireEvent.click(screen.getByRole("checkbox", { name: /start claxedo when i sign in/i }))
    fireEvent.click(screen.getByRole("button", { name: /enable remote access/i }))
    expect(onStartAtLoginChange).toHaveBeenCalledWith(true)
    expect(onEnable).toHaveBeenCalledOnce()
  })
})

describe("the machine status line", () => {
  test("states the served count and lights green only when nothing is outstanding", () => {
    mount({ serving: 3 })

    const line = screen.getByText("Serving 3 workspaces")
    expect(line).toHaveAttribute("data-serving-state", "up")
    expect(line).not.toHaveAttribute("title")
  })

  test("singular reads as one workspace, not '1 workspaces'", () => {
    mount({ serving: 1 })
    expect(screen.getByText("Serving 1 workspace")).toBeInTheDocument()
  })

  test("an outstanding publish greys the light and names what is pending", () => {
    mount({ serving: 2, servingPending: "Publishing workspaces" })

    const line = screen.getByText("Serving 2 workspaces")
    expect(line).toHaveAttribute("data-serving-state", "pending")
    expect(line).toHaveAttribute("title", "Publishing workspaces")
    expect(screen.getByText("Publishing workspaces")).toBeInTheDocument()
  })

  test("an unreported count is grey and says so — never a green light over an unknown", () => {
    // The caller has not told the panel what this machine serves. That is not
    // the same fact as "it serves everything", and it must not read as one.
    mount({ serving: undefined })

    const line = screen.getByText("Serving this machine's workspaces")
    expect(line).toHaveAttribute("data-serving-state", "pending")
    expect(line).toHaveAttribute("title", "Checking what this machine serves")
  })

  test("a workspace that could not be published gets one inline line", () => {
    mount({
      serving: 1,
      servingPending: "Some workspaces are not published yet",
      shareFailure: { label: "api", message: "relay rejected the workspace" },
    })

    expect(screen.getByText(/couldn't share api — retrying on next sync/i)).toBeInTheDocument()
    expect(screen.getByText(/relay rejected the workspace/i)).toBeInTheDocument()
  })
})

describe("the tick list is gone", () => {
  test("an enabled machine offers no per-workspace choice at all", () => {
    mount({ serving: 4, deviceLink: "https://app.claxedo.test/" })

    // No checkboxes, no skeleton rows, no per-workspace QR chooser: enabling
    // remote access already answered the only question there was.
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Loading workspaces")).not.toBeInTheDocument()
    expect(screen.queryByText("Share workspaces")).not.toBeInTheDocument()
    expect(screen.queryByText("Shared")).not.toBeInTheDocument()
  })
})

describe("connecting a device", () => {
  test("the panel opens with the link already in it — nothing is fetched to draw it", async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    mount({ serving: 2, deviceLink: "https://app.claxedo.test/" })

    fireEvent.click(screen.getByRole("button", { name: "Connect a device" }))

    // Synchronously present: the link is a pure function of a baked origin.
    const panel = screen.getByRole("dialog", { name: "Connect a device" })
    expect(panel).toBeInTheDocument()
    expect(screen.getByText("https://app.claxedo.test/")).toBeInTheDocument()

    expect(await screen.findByAltText("Remote access QR code"))
      .toHaveAttribute("src", "data:image/png;base64,qr")

    fireEvent.click(screen.getByRole("button", { name: "Copy link" }))
    expect(writeText).toHaveBeenCalledWith("https://app.claxedo.test/")

    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    expect(screen.queryByRole("dialog", { name: "Connect a device" })).not.toBeInTheDocument()
  })

  test("the QR encodes the machine's root link, not a workspace's", async () => {
    const { default: QRCode } = await import("qrcode")
    mount({ serving: 2, deviceLink: "https://app.claxedo.test/" })

    await vi.waitFor(() => {
      expect(QRCode.toDataURL).toHaveBeenCalledTimes(1)
      expect(QRCode.toDataURL).toHaveBeenCalledWith("https://app.claxedo.test/", expect.anything())
    })
  })
})

describe("who this machine is, and how to stop it", () => {
  test("a named account is stated plainly", () => {
    mount({ identity: { state: "named", label: "yash@example.test" } })
    expect(screen.getByText("yash@example.test")).toBeInTheDocument()
  })

  test("an identity still in flight spins — it never prints a placeholder name", () => {
    mount({ identity: { state: "pending" } })

    expect(screen.getByLabelText("Loading account")).toBeInTheDocument()
    expect(screen.queryByText("Account")).not.toBeInTheDocument()
  })

  test("pause is offered only where the product can actually pause", () => {
    mount({ serving: 1 })
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument()

    cleanup()
    const onPause = vi.fn()
    mount({ serving: 1, onPause })
    fireEvent.click(screen.getByRole("button", { name: "Pause" }))
    expect(onPause).toHaveBeenCalledOnce()
  })

  test("revoke names this machine, because that is the only one this panel is about", () => {
    const onRevoke = vi.fn()
    mount({ serving: 1, onRevoke })

    fireEvent.click(screen.getByRole("button", { name: "Revoke this machine" }))
    expect(onRevoke).toHaveBeenCalledWith("this-machine")
  })

  test("a product that really enumerates machines still lists them", () => {
    const onRevoke = vi.fn()
    mount({
      serving: 1,
      onRevoke,
      devices: [{ hostId: "host_1", displayName: "Yash's Mac", lastSeenAt: 10, workspaceIds: ["ws_1", "ws_2"] }],
    })

    fireEvent.click(screen.getByRole("button", { name: /revoke yash's mac/i }))
    expect(onRevoke).toHaveBeenCalledWith("host_1")
  })

  test("no machines section where there is nothing to enumerate", () => {
    mount({ serving: 1, devices: [] })
    expect(screen.queryByRole("heading", { name: "Machines" })).not.toBeInTheDocument()
  })

  test("a machine is renamed in place, and Escape leaves the name alone", () => {
    const onRename = vi.fn()
    mount({
      serving: 1,
      onRename,
      devices: [{ hostId: "host_1", displayName: "Yash's Mac", lastSeenAt: 10, workspaceIds: ["ws_1"] }],
    })

    fireEvent.click(screen.getByRole("button", { name: "Rename Yash's Mac" }))
    const field = screen.getByRole("textbox", { name: "Name for Yash's Mac" })
    fireEvent.input(field, { target: { value: "  Build box  " } })
    fireEvent.keyDown(field, { key: "Enter" })
    expect(onRename).toHaveBeenCalledWith("host_1", "Build box")

    fireEvent.click(screen.getByRole("button", { name: "Rename Yash's Mac" }))
    fireEvent.input(screen.getByRole("textbox", { name: "Name for Yash's Mac" }), { target: { value: "Discarded" } })
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Name for Yash's Mac" }), { key: "Escape" })
    expect(onRename).toHaveBeenCalledTimes(1)
  })

  test("a product that knows only its own machine still shows one row, named", () => {
    mount({
      serving: 2,
      devices: [],
      thisMachine: { displayName: "Yashvardhan's MacBook Pro", online: true, workspaceIds: ["ws_1", "ws_2"] },
    })

    expect(screen.getByRole("heading", { name: "Machines" })).toBeInTheDocument()
    const row = screen.getByText("Yashvardhan's MacBook Pro").closest("div[class*='justify-between']")
    expect(row).not.toBeNull()
    expect(row?.textContent).toContain("This computer · Remote access on")
    expect(row?.textContent).toContain("2 workspaces")
    // The panel's own Revoke covers this machine; a second one on the row
    // would be two controls for one action.
    expect(screen.queryByRole("button", { name: /^Revoke Yashvardhan/ })).not.toBeInTheDocument()
  })

  test("its own row is renamed through the control every machine row has", () => {
    const onRename = vi.fn()
    mount({
      serving: 0,
      onRename,
      devices: [],
      thisMachine: { displayName: "Yashvardhan's MacBook Pro", online: false, workspaceIds: [] },
    })

    expect(screen.getByText(/This computer · Remote access off/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Rename Yashvardhan's MacBook Pro" }))
    const field = screen.getByRole("textbox", { name: "Name for Yashvardhan's MacBook Pro" })
    fireEvent.input(field, { target: { value: "Studio Mac" } })
    fireEvent.keyDown(field, { key: "Enter" })
    expect(onRename).toHaveBeenCalledWith("this-machine", "Studio Mac")
  })

  test("a product that cannot rename offers no rename control", () => {
    mount({
      serving: 1,
      devices: [{ hostId: "host_1", displayName: "Yash's Mac", lastSeenAt: 10, workspaceIds: ["ws_1"] }],
    })
    expect(screen.queryByRole("button", { name: "Rename Yash's Mac" })).not.toBeInTheDocument()
  })
})

describe("provider configuration on a machine row", () => {
  const devices = [
    { hostId: "host_1", displayName: "Build box", lastSeenAt: 10, workspaceIds: ["ws_1"] },
    { hostId: "host_2", displayName: "Studio Mac", lastSeenAt: 10, workspaceIds: [] },
  ]

  test("each machine carries its own standing, and a push names that machine's enrollment", async () => {
    const onPush = vi.fn(async () => undefined)
    mount({
      serving: 1,
      devices,
      providerConfig: {
        rows: [
          { enrollmentId: "enr_1", hostId: "host_1", revision: 0, ackedRevision: 0, sealingKeyDeclared: true, providers: [], rekeyed: false },
          { enrollmentId: "enr_2", hostId: "host_2", revision: 0, ackedRevision: 0, sealingKeyDeclared: false, providers: [], rekeyed: false },
        ],
        onPush,
        onClear: async () => undefined,
      },
    })

    expect(screen.getByText("No provider configuration pushed")).toBeInTheDocument()
    expect(screen.getByText(/declares its sealing key on its next heartbeat/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Configure providers on Studio Mac" })).toBeDisabled()

    fireEvent.click(screen.getByRole("button", { name: "Configure providers on Build box" }))
    fireEvent.input(screen.getByLabelText("Provider id"), { target: { value: "anthropic" } })
    fireEvent.input(screen.getByLabelText("Base URL"), { target: { value: "https://api.anthropic.com" } })
    fireEvent.input(screen.getByLabelText("API key"), { target: { value: "sk-ant-1" } })
    fireEvent.click(screen.getByRole("button", { name: "Push to Build box" }))
    await waitFor(() => expect(onPush).toHaveBeenCalledWith("enr_1", {
      anthropic: { baseUrl: "https://api.anthropic.com", placeholder: "sk-ant-1", authMode: "api-key" },
    }))
  })

  test("a product that cannot list enrollments shows no provider control at all", () => {
    mount({ serving: 1, devices })
    expect(document.querySelector('[data-slot="provider-config"]')).toBeNull()
  })
})

describe("adding a machine", () => {
  test("the connect one-liner is offered for another machine, never for one the desktop app serves", () => {
    mount({ serving: 1, servedByDesktopApp: true })

    expect(screen.getByText(/the desktop app already serves this machine/i)).toBeInTheDocument()
    const connectBlock = document.querySelector('[data-slot="add-connect-host"]')
    expect(connectBlock?.textContent).toContain("claxedo connect")
    expect(screen.queryByText(/install the claxedo desktop app on it/i)).not.toBeInTheDocument()
  })

  test("a machine the desktop app does not serve is told to install the app, and still gets the one-liner for others", () => {
    mount({ serving: 1 })

    expect(screen.getByText(/install the claxedo desktop app on it/i)).toBeInTheDocument()
    expect(screen.queryByText(/the desktop app already serves this machine/i)).not.toBeInTheDocument()
    expect(document.querySelector('[data-slot="add-connect-host"]')?.textContent).toContain("claxedo connect")
  })

  test("the enable switch states what publication sends before it is pressed", () => {
    mount({ availability: { state: "ready-to-enable" } })

    expect(screen.getByText(
      "Your workspace names and paths are sent to the control plane so your other devices can find them.",
    )).toBeInTheDocument()
  })
})
