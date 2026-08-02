import { render, screen } from "@solidjs/testing-library"
import { beforeAll, describe, expect, test, vi } from "vitest"
import { configureAppPortsForTest } from "@/app/integrations/test-support/app-ports-stub"
import { SandboxProviderSurface } from "./sandbox-provider-surface"
import type { SandboxProviderCatalog } from "./sandbox-provider-api"
import type { SetupStepSubmit } from "./ai-connect-surface"

// The driver auth URL is an injected port.
beforeAll(() => configureAppPortsForTest())

const catalog: SandboxProviderCatalog = {
  defaultProviderId: "daytona",
  providers: [{
    id: "daytona",
    label: "Daytona",
    fields: [{ key: "apiKey", label: "API key", secret: true }],
    configured: false,
    isDefault: true,
  }],
}

describe("SandboxProviderSurface", () => {
  test("asks for the key of an unconfigured provider — the circularity fix", () => {
    render(() => <SandboxProviderSurface catalog={catalog} />)

    expect(screen.getByLabelText("API key")).toBeInTheDocument()
  })

  test("names the provider when there is only one, since no picker shows it", () => {
    // Found by vision review: a lone provider hid the picker, so the screen
    // asked for "an API key" with nothing on it saying whose.
    render(() => <SandboxProviderSurface catalog={catalog} />)

    expect(screen.getByText(/This server runs cloud workspaces on/i)).toBeInTheDocument()
    expect(screen.getByText("Daytona")).toBeInTheDocument()
  })

  test("says the key is the user's own and needs no account", () => {
    render(() => <SandboxProviderSurface catalog={catalog} />)

    expect(screen.getByText(/needs no\s+account for this/i)).toBeInTheDocument()
  })

  test("the save is gated until every field is filled", async () => {
    let submit: SetupStepSubmit | undefined
    render(() => <SandboxProviderSurface catalog={catalog} registerSubmit={(value) => (submit = value)} />)

    expect(submit?.count()).toBe(0)
    const input = screen.getByLabelText("API key") as HTMLInputElement
    input.value = "dtn_live_123"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    expect(submit?.count()).toBe(1)
  })

  test("saving sends the key and reports the provider ready", async () => {
    const write = vi.fn(async () => ({
      default_driver: "daytona",
      drivers: [{ id: "daytona", label: "Daytona", fields: [], configured: true, default: true }],
    }))
    const onConfigured = vi.fn()
    let submit: SetupStepSubmit | undefined
    render(() => (
      <SandboxProviderSurface
        catalog={catalog}
        write={write}
        authUrl={({ driverId }) => `https://server/api/workspace/drivers/${driverId}/auth`}
        onConfigured={onConfigured}
        registerSubmit={(value) => (submit = value)}
      />
    ))

    const input = screen.getByLabelText("API key") as HTMLInputElement
    input.value = "dtn_live_123"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    await submit?.run()

    expect(write).toHaveBeenCalledWith(expect.stringContaining("daytona"), {
      auth: { apiKey: "dtn_live_123" },
      default: true,
    })
    expect(onConfigured).toHaveBeenCalled()
    expect(screen.getByText(/ready for cloud workspaces/i)).toBeInTheDocument()
  })

  test("a rejection surfaces a sentence and a repair, never a server code", async () => {
    const write = vi.fn(async () => {
      throw new Error("sandbox_driver_credentials_missing: Missing daytona credentials")
    })
    let submit: SetupStepSubmit | undefined
    const { container } = render(() => (
      <SandboxProviderSurface
        catalog={catalog}
        write={write}
        authUrl={({ driverId }) => `https://server/api/workspace/drivers/${driverId}/auth`}
        registerSubmit={(value) => (submit = value)}
      />
    ))

    const input = screen.getByLabelText("API key") as HTMLInputElement
    input.value = "bad"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    await submit?.run()

    expect(screen.getByText(/no working key.*save it again/i)).toBeInTheDocument()
    expect(container.textContent).not.toContain("sandbox_driver_credentials_missing")
  })

  test("a server with no providers says cloud is unavailable rather than showing an empty form", () => {
    render(() => <SandboxProviderSurface catalog={{ providers: [] }} />)

    expect(screen.getByText(/offers no sandbox providers/i)).toBeInTheDocument()
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
  })

  test("several providers are pickable, and only the picked one asks for a key", () => {
    const many: SandboxProviderCatalog = {
      defaultProviderId: "daytona",
      providers: [
        catalog.providers[0]!,
        { id: "e2b", label: "E2B", fields: [{ key: "token", label: "Token", secret: true }], configured: false, isDefault: false },
      ],
    }
    render(() => <SandboxProviderSurface catalog={many} />)

    expect(screen.getByLabelText("API key")).toBeInTheDocument()
    expect(screen.queryByLabelText("Token")).not.toBeInTheDocument()

    screen.getByText("E2B").click()
    expect(screen.getByLabelText("Token")).toBeInTheDocument()
    expect(screen.queryByLabelText("API key")).not.toBeInTheDocument()
  })

  test("an already-configured provider reads as ready", () => {
    render(() => (
      <SandboxProviderSurface
        catalog={{ ...catalog, providers: [{ ...catalog.providers[0]!, configured: true }] }}
      />
    ))

    expect(screen.getByText(/Daytona is ready for cloud workspaces/i)).toBeInTheDocument()
  })
})
