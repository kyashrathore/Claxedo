import { fireEvent, render, screen } from "@solidjs/testing-library"
import { describe, expect, test, vi } from "vitest"
import { RemoteAccessSurface } from "./remote-access-surface"

vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn(async () => "data:image/png;base64,qr") } }))

describe("RemoteAccessSurface", () => {
  test("renders blocker-honest locked copy and cannot enable", () => {
    render(() => (
      <RemoteAccessSurface
        availability={{
          state: "locked",
          reason: "Remote access is coming soon. The hosted relay is not available yet.",
        }}
        devices={[]}
        startAtLogin={false}
        onStartAtLoginChange={() => undefined}
        onEnable={() => undefined}
        onSignIn={() => undefined}
        onRevoke={() => undefined}
      />
    ))

    expect(screen.getByText(/hosted relay is not available yet/i)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /enable remote access/i })).not.toBeInTheDocument()
  })

  test("offers startup survival before enablement", () => {
    const onStartAtLoginChange = vi.fn()
    const onEnable = vi.fn()
    render(() => (
      <RemoteAccessSurface
        availability={{ state: "ready-to-enable" }}
        devices={[]}
        startAtLogin={false}
        onStartAtLoginChange={onStartAtLoginChange}
        onEnable={onEnable}
        onSignIn={() => undefined}
        onRevoke={() => undefined}
      />
    ))

    fireEvent.click(screen.getByRole("checkbox", { name: /start claxedo when i sign in/i }))
    fireEvent.click(screen.getByRole("button", { name: /enable remote access/i }))
    expect(onStartAtLoginChange).toHaveBeenCalledWith(true)
    expect(onEnable).toHaveBeenCalledOnce()
  })

  test("renders QR/copy link, conservative mobile copy, proof, and device revoke", async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    const onRevoke = vi.fn()
    render(() => (
      <RemoteAccessSurface
        availability={{ state: "enabled", proven: true }}
        workspaceLink="https://app.claxedo.test/w/ws_1?claxedo_second_device=1"
        devices={[{ hostId: "host_1", displayName: "Yash's Mac", lastSeenAt: 10, workspaceIds: ["ws_1", "ws_2"] }]}
        startAtLogin={true}
        onStartAtLoginChange={() => undefined}
        onEnable={() => undefined}
        onSignIn={() => undefined}
        onRevoke={onRevoke}
      />
    ))

    expect(await screen.findByAltText("Remote workspace QR code")).toHaveAttribute("src", "data:image/png;base64,qr")
    expect(screen.getByText(/monitor running work and reply from your phone/i)).toBeInTheDocument()
    expect(screen.getByText("Opened on a second device")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }))
    expect(writeText).toHaveBeenCalledWith("https://app.claxedo.test/w/ws_1?claxedo_second_device=1")
    fireEvent.click(screen.getByRole("button", { name: /revoke yash's mac/i }))
    expect(onRevoke).toHaveBeenCalledWith("host_1")
  })
})
