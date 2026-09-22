import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { AddMachine, MachinesList } from "./machines-section"

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard")
beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  cleanup()
  if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor)
  else Reflect.deleteProperty(navigator, "clipboard")
})

const DEVICE = { hostId: "host_1", displayName: "Yash's Mac", lastSeenAt: 10, workspaceIds: ["ws_1", "ws_2"] }

describe("the fleet", () => {
  test("a product that really enumerates machines lists them, and revoke names the one it ends", () => {
    const onRevoke = vi.fn()
    render(() => <MachinesList devices={[DEVICE]} onRevoke={onRevoke} />)

    fireEvent.click(screen.getByRole("button", { name: /revoke yash's mac/i }))
    expect(onRevoke).toHaveBeenCalledWith("host_1")
  })

  test("nothing enrolled opens on the instructions, which are the whole empty state", () => {
    render(() => <MachinesList devices={[]} onRevoke={() => {}} />)

    expect(screen.getByText(/no machine is enrolled yet/i)).toBeInTheDocument()
    const block = document.querySelector('[data-slot="add-connect-host"]')
    expect(block?.textContent).toContain("claxedo host invite")
    // Nothing to press to read them: they are already open.
    expect(screen.queryByRole("button", { name: "Add another machine" })).not.toBeInTheDocument()
  })

  test("once a machine exists the instructions fold away behind one line", () => {
    render(() => <MachinesList devices={[DEVICE]} onRevoke={() => {}} />)

    expect(document.querySelector('[data-slot="add-connect-host"]')).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Add another machine" }))
    expect(document.querySelector('[data-slot="add-connect-host"]')?.textContent).toContain("claxedo connect")
  })

  test("a machine beating within the window reads as connected; one that stopped reads as last seen", () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    render(() => (
      <MachinesList
        devices={[
          { ...DEVICE, hostId: "fresh", displayName: "Build box", lastSeenAt: 1_000_000 - 20_000 },
          { ...DEVICE, hostId: "gone", displayName: "Studio Mac", lastSeenAt: 1_000_000 - 600_000 },
        ]}
        onRevoke={() => {}}
      />
    ))

    const states = [...document.querySelectorAll('[data-component="machine-state"]')]
    expect(states.map((node) => node.getAttribute("data-online"))).toEqual(["true", "false"])
    expect(states[0]?.textContent).toContain("Connected")
    expect(states[1]?.textContent).toMatch(/last seen/i)
    vi.useRealTimers()
  })

  test("a product that knows only its own machine still shows one row, named and stated", () => {
    render(() => (
      <MachinesList
        devices={[]}
        thisMachine={{ displayName: "Yashvardhan's MacBook Pro", online: true, workspaceIds: ["ws_1", "ws_2"] }}
        onRevoke={() => {}}
      />
    ))

    const row = screen.getByText("Yashvardhan's MacBook Pro").closest('[class*="justify-between"]')
    expect(row?.textContent).toContain("Connected · this computer")
    expect(row?.textContent).toContain("2 workspaces")
    // The panel above already revokes this machine; a second control on the
    // row would be two ways to do one thing.
    expect(screen.queryByRole("button", { name: /^Revoke Yashvardhan/ })).not.toBeInTheDocument()
  })

  test("a machine is renamed in place, and Escape leaves the name alone", () => {
    const onRename = vi.fn()
    render(() => <MachinesList devices={[DEVICE]} onRevoke={() => {}} onRename={onRename} />)

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

  test("its own row is renamed through the control every machine row has", () => {
    const onRename = vi.fn()
    render(() => (
      <MachinesList
        devices={[]}
        thisMachine={{ displayName: "Yashvardhan's MacBook Pro", online: false, workspaceIds: [] }}
        onRevoke={() => {}}
        onRename={onRename}
      />
    ))

    expect(screen.getByText(/Not connected · this computer/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Rename Yashvardhan's MacBook Pro" }))
    const field = screen.getByRole("textbox", { name: "Name for Yashvardhan's MacBook Pro" })
    fireEvent.input(field, { target: { value: "Studio Mac" } })
    fireEvent.keyDown(field, { key: "Enter" })
    expect(onRename).toHaveBeenCalledWith("this-machine", "Studio Mac")
  })

  test("a product that cannot rename offers no rename control", () => {
    render(() => <MachinesList devices={[DEVICE]} onRevoke={() => {}} />)
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
    render(() => (
      <MachinesList
        devices={devices}
        onRevoke={() => {}}
        providerConfig={{
          rows: [
            { enrollmentId: "enr_1", hostId: "host_1", revision: 0, ackedRevision: 0, sealingKeyDeclared: true, providers: [], rekeyed: false },
            { enrollmentId: "enr_2", hostId: "host_2", revision: 0, ackedRevision: 0, sealingKeyDeclared: false, providers: [], rekeyed: false },
          ],
          onPush,
          onClear: async () => undefined,
        }}
      />
    ))

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
    render(() => <MachinesList devices={devices} onRevoke={() => {}} />)
    expect(document.querySelector('[data-slot="provider-config"]')).toBeNull()
  })
})

describe("adding a machine", () => {
  test("the computer the desktop app already serves is told there is nothing to install", () => {
    render(() => <AddMachine servedByDesktopApp empty />)

    expect(screen.getByText(/the desktop app already serves this machine/i)).toBeInTheDocument()
    expect(screen.queryByText(/install the claxedo desktop app on it/i)).not.toBeInTheDocument()
  })

  test("a machine the desktop app does not serve is told to install the app", () => {
    render(() => <AddMachine empty />)

    expect(screen.getByText(/install the claxedo desktop app on it/i)).toBeInTheDocument()
    expect(screen.queryByText(/the desktop app already serves this machine/i)).not.toBeInTheDocument()
  })

  test("the two commands are in the order they are run, and each copies itself", () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    render(() => <AddMachine empty />)

    const commands = [...document.querySelectorAll('[data-slot="add-connect-host"] code')].map((node) => node.textContent)
    expect(commands?.[0]).toContain("claxedo host invite")
    expect(commands?.[1]).toContain("claxedo connect")

    fireEvent.click(screen.getByRole("button", { name: "Copy connect command" }))
    expect(writeText).toHaveBeenCalledWith("claxedo connect --token-file ./invite.txt --install-service")
  })
})
