import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { JSX } from "solid-js"

const mocks = vi.hoisted(() => ({
  apiDelete: vi.fn(),
  apiGet: vi.fn(),
  apiPut: vi.fn(),
  baseUrl: "http://127.0.0.1:3001",
  funnelEmit: vi.fn(),
  toast: vi.fn(),
}))

type Bag = {
  children?: JSX.Element
  disabled?: boolean
  onClick?: () => void
}

type SelectItem = {
  id: string
  label: string
}

type SelectBag = Bag & {
  current?: SelectItem
  options?: SelectItem[]
  onSelect?: (item: SelectItem | undefined) => void
}

function provider(configured: boolean) {
  return {
    id: "daytona",
    label: "Daytona",
    fields: [{ key: "api_key", label: "API Key", secret: true }],
    configured,
    source: configured ? "config" : "none",
    default: true,
  }
}

vi.mock("@opencode-ai/ui/button", () => ({
  Button: (props: Bag) => (
    <button type="button" disabled={props.disabled === true} onClick={props.onClick}>
      {props.children}
    </button>
  ),
}))

vi.mock("@opencode-ai/ui/select", () => ({
  Select: (props: SelectBag) => (
    <select
      aria-label="Default provider"
      disabled={props.disabled === true}
      value={props.current?.id ?? ""}
      onInput={(e) => props.onSelect?.(props.options?.find((item) => item.id === e.currentTarget.value))}
    >
      {(props.options ?? []).map((item) => (
        <option value={item.id}>{item.label}</option>
      ))}
    </select>
  ),
}))

vi.mock("@opencode-ai/ui/toast", () => ({
  showToast: (...args: unknown[]) => mocks.toast(...args),
}))

vi.mock("@/platform/api/api", () => ({
  api: {
    delete: (...args: unknown[]) => mocks.apiDelete(...args),
    get: (...args: unknown[]) => mocks.apiGet(...args),
    put: (...args: unknown[]) => mocks.apiPut(...args),
  },
  getClaxedoServerUrl: () => mocks.baseUrl,
  getDefaultBaseUrl: () => mocks.baseUrl,
  normalizeUrl: (url: string | undefined) => url?.trim().replace(/\/+$/, "") || undefined,
}))

vi.mock("./network-policy", () => ({
  NetworkPolicySettings: () => <div data-testid="network-policy" />,
}))

vi.mock("../app-ports", () => ({
  useSandboxOnboardingFunnel: () => ({ emit: mocks.funnelEmit }),
}))

beforeEach(() => {
  mocks.apiDelete.mockReset()
  mocks.apiGet.mockReset()
  mocks.apiPut.mockReset()
  mocks.baseUrl = "http://127.0.0.1:3001"
  mocks.funnelEmit.mockReset()
  mocks.toast.mockReset()
})

afterEach(() => {
  cleanup()
})

describe("SandboxSettingsSection", () => {
  test("emits the configured-provider onboarding milestone after a successful save", async () => {
    mocks.apiGet.mockResolvedValue({ default_provider: "daytona", providers: [provider(false)] })
    mocks.apiPut.mockResolvedValue({ default_provider: "daytona", providers: [provider(true)] })

    const { SandboxSettingsSection } = await import("./sandbox-section")
    render(() => <SandboxSettingsSection />)

    await waitFor(() => expect(screen.getByText("Not configured")).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: "Configure" }))
    fireEvent.input(screen.getByPlaceholderText("API Key"), { target: { value: "secret" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(mocks.funnelEmit).toHaveBeenCalledWith({
      name: "sandbox_provider_configured",
      provider: "daytona",
    }))
  })

  test("refreshes provider state after credentials are removed", async () => {
    mocks.apiGet
      .mockResolvedValueOnce({ default_provider: "daytona", providers: [provider(true)] })
      .mockResolvedValueOnce({ default_provider: "daytona", providers: [provider(false)] })
    mocks.apiDelete.mockResolvedValue({ ok: true })

    const { SandboxSettingsSection } = await import("./sandbox-section")
    render(() => <SandboxSettingsSection />)

    await waitFor(() => expect(screen.getByText(/Credentials configured/)).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: "Remove" }))

    await waitFor(() =>
      expect(mocks.apiDelete).toHaveBeenCalledWith("http://127.0.0.1:3001/api/workspace/providers/daytona/auth"),
    )
    await waitFor(() => expect(screen.getByText("Not configured")).toBeInTheDocument())
    expect(mocks.toast).toHaveBeenCalledWith({ variant: "success", title: "Daytona credentials removed" })
  })

  test("renders local provider settings read-only for hosted control-plane access", async () => {
    mocks.baseUrl = "https://claxedo.example.test"
    mocks.apiGet.mockResolvedValue({ default_provider: "daytona", providers: [provider(true)] })

    const { SandboxSettingsSection } = await import("./sandbox-section")
    render(() => <SandboxSettingsSection />)

    await waitFor(() => expect(screen.getByText(/Credentials configured/)).toBeInTheDocument())
    expect(screen.getByLabelText("Default provider")).toBeDisabled()
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Update" })).toBeDisabled()
    expect(
      screen.getByText("Signed hosted sessions can view local sandbox providers but cannot change local credentials."),
    ).toBeInTheDocument()
  })
})
