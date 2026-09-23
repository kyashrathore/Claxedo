import { createSignal } from "solid-js"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { SandboxProviderCatalog, SandboxProviderVerification } from "./sandbox-provider-api"

const fixture = vi.hoisted(() => ({
  catalog: { providers: [] } as { providers: Array<{ id: string; label: string; fields: Array<{ key: string; label: string; secret: boolean }>; configured: boolean; isDefault: boolean; verification?: { state: "working" | "broken" | "unknown"; reason?: string } }>; defaultProviderId?: string },
  saves: [] as Array<{ providerId: string; values: Record<string, string> }>,
  verification: { state: "working" } as SandboxProviderVerification,
  saveFailure: undefined as string | undefined,
}))

vi.mock("@/features/onboarding/app-ports", () => ({
  workspaceSandboxDriversUrl: () => "http://server.test/api/workspace/drivers",
  workspaceSandboxDriverAuthUrl: (input: { driverId: string }) => `http://server.test/api/workspace/drivers/${input.driverId}/auth`,
  SandboxDriverLogo: (props: { id: string }) => <span data-logo={props.id} />,
}))

vi.mock("@/features/onboarding/sandbox-provider-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sandbox-provider-api")>()),
  readSandboxProviderCatalog: async (): Promise<SandboxProviderCatalog> => fixture.catalog,
  saveSandboxProviderKey: async (input: { providerId: string; values: Record<string, string> }) => {
    fixture.saves.push({ providerId: input.providerId, values: input.values })
    if (fixture.saveFailure) return { ok: false as const, reason: fixture.saveFailure }
    const catalog = {
      ...fixture.catalog,
      providers: fixture.catalog.providers.map((provider) =>
        provider.id === input.providerId ? { ...provider, configured: true, verification: fixture.verification } : provider),
    }
    return { ok: true as const, catalog, verification: fixture.verification }
  },
}))

const { ExecutionStep } = await import("./execution-step")

function mount(input: { localExecution: boolean; choice?: "local" | "cloud" | "connected" }) {
  const ready: boolean[] = []
  const [choice, setChoice] = createSignal<"local" | "cloud" | "connected">(input.choice ?? (input.localExecution ? "local" : "cloud"))
  render(() => (
    <ExecutionStep
      baseUrl="http://server.test"
      localExecution={input.localExecution}
      choice={choice()}
      onChoice={setChoice}
      onReady={(value) => ready.push(value)}
    />
  ))
  return { ready, choice }
}

const daytona = { id: "daytona", label: "Daytona", fields: [{ key: "api_key", label: "API key", secret: true }], configured: false, isDefault: true }
const modal = { id: "modal", label: "Modal", fields: [{ key: "token_id", label: "Token id", secret: false }, { key: "token_secret", label: "Token secret", secret: true }], configured: false, isDefault: false }

afterEach(() => {
  fixture.catalog = { providers: [] }
  fixture.saves = []
  fixture.verification = { state: "working" }
  fixture.saveFailure = undefined
  cleanup()
})

describe("ExecutionStep on a desktop", () => {
  test("this machine is ready on entry; the cloud row waits for a key the provider accepts", async () => {
    fixture.catalog = { providers: [daytona, modal], defaultProviderId: "daytona" }
    const { ready } = mount({ localExecution: true })
    expect(ready.at(-1)).toBe(true)

    fireEvent.click(screen.getByRole("radio", { name: /A cloud sandbox/ }))
    await waitFor(() => expect(screen.getByRole("radio", { name: /Daytona/ })).toBeTruthy())
    expect(ready.at(-1)).toBe(false)
    expect(screen.getByRole("radio", { name: /Daytona/ }).getAttribute("aria-checked")).toBe("true")

    fireEvent.input(screen.getByLabelText("API key"), { target: { value: "dtn_key" } })
    fireEvent.click(screen.getByRole("button", { name: "Save key" }))
    await waitFor(() => expect(fixture.saves).toEqual([{ providerId: "daytona", values: { api_key: "dtn_key" } }]))
    await waitFor(() => expect(ready.at(-1)).toBe(true))
    expect(document.querySelector('[data-slot="onboarding-sandbox-verdict"]')?.getAttribute("data-state")).toBe("working")
  })

  test("a broken key is not done; an uncheckable one is, with its reason shown", async () => {
    fixture.catalog = { providers: [daytona, modal], defaultProviderId: "daytona" }
    fixture.verification = { state: "broken", reason: "Daytona said the key is invalid." }
    const { ready } = mount({ localExecution: true, choice: "cloud" })
    await waitFor(() => expect(screen.getByLabelText("API key")).toBeTruthy())
    fireEvent.input(screen.getByLabelText("API key"), { target: { value: "bad" } })
    fireEvent.click(screen.getByRole("button", { name: "Save key" }))
    await waitFor(() => expect(screen.getByText("Daytona said the key is invalid.")).toBeTruthy())
    expect(ready.at(-1)).toBe(false)

    fixture.verification = { state: "unknown", reason: "Modal's control plane cannot be asked; the key is saved." }
    fireEvent.click(screen.getByRole("radio", { name: /Modal/ }))
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Token id" })).toBeTruthy())
    expect(screen.getByRole("button", { name: "Save key" }).disabled).toBe(true)
    fireEvent.input(screen.getByRole("textbox", { name: "Token id" }), { target: { value: "id" } })
    fireEvent.input(screen.getByLabelText("Token secret"), { target: { value: "secret" } })
    fireEvent.click(screen.getByRole("button", { name: "Save key" }))
    await waitFor(() => expect(screen.getByText("Modal's control plane cannot be asked; the key is saved.")).toBeTruthy())
    expect(ready.at(-1)).toBe(true)
  })

  test("a refused save shows the reason and stays not done", async () => {
    fixture.catalog = { providers: [daytona], defaultProviderId: "daytona" }
    fixture.saveFailure = "The provider rejected that key. Check it was copied whole, then save it again."
    const { ready } = mount({ localExecution: true, choice: "cloud" })
    await waitFor(() => expect(screen.getByLabelText("API key")).toBeTruthy())
    fireEvent.input(screen.getByLabelText("API key"), { target: { value: "x" } })
    fireEvent.click(screen.getByRole("button", { name: "Save key" }))
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(fixture.saveFailure))
    expect(ready.at(-1)).toBe(false)
  })

  test("a provider that already holds a working key is done on entry", async () => {
    fixture.catalog = { providers: [{ ...daytona, configured: true, verification: { state: "working" } }], defaultProviderId: "daytona" }
    const { ready } = mount({ localExecution: true, choice: "cloud" })
    await waitFor(() => expect(ready.at(-1)).toBe(true))
    expect(screen.getByRole("button", { name: "Replace key" })).toBeTruthy()
  })

  test("the machine row shows the two commands and keeps Finish open", () => {
    const { ready } = mount({ localExecution: true, choice: "connected" })
    expect(screen.getByDisplayValue("claxedo host invite --name build-box --root ~/code")).toBeTruthy()
    expect(screen.getByDisplayValue("claxedo connect --token-file ./invite.txt --install-service")).toBeTruthy()
    expect(screen.getByText(/Machines you connect appear in Settings/)).toBeTruthy()
    expect(ready.at(-1)).toBe(true)
  })
})

describe("ExecutionStep on the hosted plane", () => {
  test("offers no local row; the deployment's sandbox is done as-is and a machine cannot finish", async () => {
    const { ready } = mount({ localExecution: false })
    expect(screen.queryByRole("radio", { name: /Just this machine/ })).toBeNull()
    expect(document.querySelector('[data-slot="onboarding-cloud-hosted"]')).toBeTruthy()
    expect(ready.at(-1)).toBe(true)
    expect(fixture.saves).toEqual([])

    fireEvent.click(screen.getByRole("radio", { name: /Another machine/ }))
    await waitFor(() => expect(ready.at(-1)).toBe(false))
    expect(screen.getByText(/Nothing can send this repository to a machine you connect yet/)).toBeTruthy()
  })
})
