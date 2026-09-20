import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { MachineProviderConfigRow } from "@/platform/remote-access/machine-remote-access-port"
import { MachineProviderConfig, machineProviderConfigStatus, type MachineProviderConfigProps } from "./machine-provider-config"

const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level))
beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)

const declared: MachineProviderConfigRow = {
  enrollmentId: "enr_1",
  hostId: "host_1",
  revision: 0,
  ackedRevision: 0,
  sealingKeyDeclared: true,
  providers: [],
  rekeyed: false,
}

function mount(props: Partial<MachineProviderConfigProps> = {}) {
  const merged: MachineProviderConfigProps = {
    machineName: "Build box",
    row: declared,
    onPush: async () => undefined,
    onClear: async () => undefined,
    ...props,
  }
  render(() => <MachineProviderConfig {...merged} />)
  return document.querySelector('[data-slot="provider-config"]') as HTMLElement
}

const SECRET = "sk-ant-never-logged-9f3a"

describe("where a machine stands with pushed providers", () => {
  test("the four states, and the one that cannot be configured, are told apart", () => {
    const standing = { rekeyed: false }
    expect(machineProviderConfigStatus({ ...standing, revision: 0, ackedRevision: 0, sealingKeyDeclared: true })).toBe("none")
    expect(machineProviderConfigStatus({ ...standing, revision: 3, ackedRevision: 2, sealingKeyDeclared: true })).toBe("pending")
    expect(machineProviderConfigStatus({ ...standing, revision: 3, ackedRevision: 3, sealingKeyDeclared: true })).toBe("applied")
    expect(machineProviderConfigStatus({ ...standing, revision: 3, ackedRevision: 3, sealingKeyDeclared: false }))
      .toBe("unconfigurable")
    // A re-keyed machine never acks, so it must not read as pending.
    expect(machineProviderConfigStatus({ revision: 3, ackedRevision: 2, sealingKeyDeclared: true, rekeyed: true }))
      .toBe("rekeyed")
  })

  test("a machine that re-keyed after the push is told to be pushed again, not left reading as pending", () => {
    const block = mount({ row: { ...declared, revision: 2, ackedRevision: 0, rekeyed: true, providers: ["openai"] } })
    expect(block).toHaveAttribute("data-state", "rekeyed")
    expect(screen.getByText(/replaced its sealing key, so revision 2 can never reach it\. Push again\./))
      .toBeInTheDocument()
  })

  test("nothing pushed", () => {
    const block = mount()
    expect(block).toHaveAttribute("data-state", "none")
    expect(screen.getByText("No provider configuration pushed")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Clear providers on Build box" })).not.toBeInTheDocument()
  })

  test("pushed, and the machine has not picked it up yet", () => {
    const block = mount({ row: { ...declared, revision: 2, ackedRevision: 1 } })
    expect(block).toHaveAttribute("data-state", "pending")
    expect(screen.getByText("Revision 2 pushed · the machine still holds revision 1")).toBeInTheDocument()
  })

  test("pushed, and the machine has it: the row names what it holds", () => {
    const block = mount({ row: { ...declared, revision: 2, ackedRevision: 2, providers: ["anthropic", "openai"] } })
    expect(block).toHaveAttribute("data-state", "applied")
    expect(screen.getByText("Revision 2 on the machine · anthropic, openai")).toBeInTheDocument()

    cleanup()
    mount({ row: { ...declared, revision: 3, ackedRevision: 3 } })
    expect(screen.getByText("Revision 3 on the machine · no providers")).toBeInTheDocument()
  })

  test("a machine without a sealing key cannot be configured, and the control says why", () => {
    const block = mount({ row: { ...declared, sealingKeyDeclared: false } })
    expect(block).toHaveAttribute("data-state", "unconfigurable")
    const configure = screen.getByRole("button", { name: "Configure providers on Build box" })
    expect(configure).toBeDisabled()
    expect(configure).toHaveAttribute("title", expect.stringContaining("declares its sealing key on its next heartbeat"))
    expect(screen.getByText(/declares its sealing key on its next heartbeat/)).toBeInTheDocument()
    fireEvent.click(configure)
    expect(screen.queryByRole("textbox", { name: "Provider id" })).not.toBeInTheDocument()
  })
})

describe("pushing providers", () => {
  function fill(input: { providerId: string; baseUrl: string; secret: string; apiPath?: string; bearer?: boolean }) {
    fireEvent.click(screen.getByRole("button", { name: "Configure providers on Build box" }))
    fireEvent.input(screen.getByLabelText("Provider id"), { target: { value: input.providerId } })
    fireEvent.input(screen.getByLabelText("Base URL"), { target: { value: input.baseUrl } })
    if (input.bearer) fireEvent.change(screen.getByLabelText("Auth mode"), { target: { value: "bearer" } })
    fireEvent.input(screen.getByLabelText(input.bearer ? "Bearer token" : "API key"), { target: { value: input.secret } })
    if (input.apiPath !== undefined) {
      fireEvent.input(screen.getByLabelText("API path (optional)"), { target: { value: input.apiPath } })
    }
  }

  test("sends one provider row in the runtime's shape, keyed by the provider id, to the machine's enrollment", async () => {
    const onPush = vi.fn(async () => undefined)
    mount({ onPush })

    fill({ providerId: " anthropic ", baseUrl: "https://api.anthropic.com ", secret: SECRET, apiPath: "/v1" })
    fireEvent.click(screen.getByRole("button", { name: "Push to Build box" }))

    await waitFor(() => expect(onPush).toHaveBeenCalledOnce())
    expect(onPush).toHaveBeenCalledWith("enr_1", {
      anthropic: { baseUrl: "https://api.anthropic.com", placeholder: SECRET, authMode: "api-key", apiPath: "/v1" },
    })
  })

  test("the form says the push replaces the whole set and names what the machine holds now", () => {
    mount({ row: { ...declared, revision: 2, ackedRevision: 2, providers: ["anthropic", "openai"] } })
    fireEvent.click(screen.getByRole("button", { name: "Configure providers on Build box" }))
    expect(screen.getByText(/Pushing replaces every provider it holds \(now anthropic, openai\)/)).toBeInTheDocument()
    // Nothing here may promise more than the push delivers: the blob is sealed
    // for the machine, and what the machine does with the key afterwards is
    // the harness profile's business.
    expect(screen.getByText(/Sealed for this machine; only this machine can open it/)).toBeInTheDocument()
    expect(document.body.innerHTML).not.toContain("never stored in the clear")
  })

  test("a bearer provider with no API path sends no apiPath at all", async () => {
    const onPush = vi.fn(async () => undefined)
    mount({ onPush })

    fill({ providerId: "openai", baseUrl: "https://api.openai.com", secret: SECRET, bearer: true })
    fireEvent.click(screen.getByRole("button", { name: "Push to Build box" }))

    await waitFor(() => expect(onPush).toHaveBeenCalledOnce())
    expect(onPush).toHaveBeenCalledWith("enr_1", {
      openai: { baseUrl: "https://api.openai.com", placeholder: SECRET, authMode: "bearer" },
    })
  })

  test("the key is gone from the component once the push resolves, and never reaches a console", async () => {
    let resolvePush: () => void = () => undefined
    const onPush = vi.fn(() => new Promise<void>((resolve) => { resolvePush = resolve }))
    mount({ onPush })

    fill({ providerId: "anthropic", baseUrl: "https://api.anthropic.com", secret: SECRET })
    expect(screen.getByLabelText("API key")).toHaveValue(SECRET)
    fireEvent.click(screen.getByRole("button", { name: "Push to Build box" }))
    await waitFor(() => expect(onPush).toHaveBeenCalledOnce())
    resolvePush()

    await waitFor(() => expect(screen.queryByLabelText("API key")).not.toBeInTheDocument())
    // Reopening shows the form with everything but the key still filled.
    const configure = screen.getByRole("button", { name: "Configure providers on Build box" })
    await waitFor(() => expect(configure).toBeEnabled())
    fireEvent.click(configure)
    expect(screen.getByLabelText("API key")).toHaveValue("")
    expect(screen.getByLabelText("Provider id")).toHaveValue("anthropic")
    expect(document.body.innerHTML).not.toContain(SECRET)
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled()
  })

  test("a refused push is shown on the block and the attempt can be retried", async () => {
    const onPush = vi.fn(async () => {
      throw new Error("The machine has not declared a sealing key; it declares one on its next heartbeat")
    })
    mount({ onPush })

    fill({ providerId: "anthropic", baseUrl: "https://api.anthropic.com", secret: SECRET })
    fireEvent.click(screen.getByRole("button", { name: "Push to Build box" }))

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("has not declared a sealing key"))
    expect(screen.getByLabelText("API key")).toHaveValue(SECRET)
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled()
  })

  test("push is not offered until the provider, its address and its key are all present", () => {
    mount()
    fireEvent.click(screen.getByRole("button", { name: "Configure providers on Build box" }))
    expect(screen.getByRole("button", { name: "Push to Build box" })).toBeDisabled()
    fireEvent.input(screen.getByLabelText("Provider id"), { target: { value: "anthropic" } })
    fireEvent.input(screen.getByLabelText("Base URL"), { target: { value: "https://api.anthropic.com" } })
    expect(screen.getByRole("button", { name: "Push to Build box" })).toBeDisabled()
    fireEvent.input(screen.getByLabelText("API key"), { target: { value: SECRET } })
    expect(screen.getByRole("button", { name: "Push to Build box" })).toBeEnabled()
  })
})

describe("clearing providers", () => {
  test("asks first, names the consequence, and only then withdraws", async () => {
    const onClear = vi.fn(async () => undefined)
    mount({ row: { ...declared, revision: 2, ackedRevision: 2 }, onClear })

    fireEvent.click(screen.getByRole("button", { name: "Clear providers on Build box" }))
    expect(onClear).not.toHaveBeenCalled()
    expect(screen.getByText(/stops every agent turn on Build box/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Keep" }))
    expect(onClear).not.toHaveBeenCalled()
    expect(screen.queryByText(/stops every agent turn/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Clear providers on Build box" }))
    fireEvent.click(screen.getByRole("button", { name: "Clear providers on Build box" }))
    await waitFor(() => expect(onClear).toHaveBeenCalledWith("enr_1"))
    await waitFor(() => expect(screen.queryByText(/stops every agent turn/)).not.toBeInTheDocument())
  })
})
