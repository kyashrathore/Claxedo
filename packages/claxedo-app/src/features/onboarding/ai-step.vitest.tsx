import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"

const fixture = vi.hoisted(() => ({
  providers: [
    { id: "anthropic", name: "Anthropic" },
    { id: "openai", name: "OpenAI" },
    { id: "openai-codex", name: "ChatGPT" },
  ],
  connected: [] as string[],
  readConnected: (() => []) as () => string[],
  setConnected: ((_: string[]) => undefined) as (value: string[]) => unknown,
  refreshes: 0,
  puts: [] as Array<{ serverUrl: string; providerId: string; harness: string; key: string }>,
  putFailure: undefined as string | undefined,
  runnable: {} as Record<string, boolean>,
  catalogConnected: {} as Record<string, string[]>,
}))

vi.mock("@/features/onboarding/app-ports", async () => {
  const { createSignal } = await import("solid-js")
  const [connected, setConnected] = createSignal<string[]>([])
  fixture.readConnected = connected
  fixture.setConnected = setConnected
  return {
  MachineAccountsProvider: (props: { children?: unknown }) => props.children,
  useMachineAccounts: () => ({ runnable: (check: { id: string }) => fixture.runnable[check.id] ?? false }),
  AgentHarnessAccounts: (props: { harness: { id: string } }) => <div data-harness-row={props.harness.id} />,
  HarnessProvidersSection: (props: { harness: string }) => <div data-providers-section={props.harness} />,
  useProviders: (harness: string) => ({
    all: () => new Map(harness === "pi" ? fixture.providers.map((provider) => [provider.id, provider]) : []),
    connected: () =>
      (harness === "pi" ? fixture.readConnected() : fixture.catalogConnected[harness] ?? []).map((id) => ({ id, name: id })),
    loading: () => false,
    error: () => undefined,
    refresh: async () => {
      fixture.refreshes += 1
      fixture.setConnected(fixture.connected)
    },
  }),
  }
})

vi.mock("@/platform/api/api", () => ({ authFetch: async () => new Response("{}") }))
vi.mock("@/platform/api/credential-request", () => ({
  putHostedProviderKey: async (input: { serverUrl: string; providerId: string; harness: string; key: string }) => {
    fixture.puts.push({ serverUrl: input.serverUrl, providerId: input.providerId, harness: input.harness, key: input.key })
    if (fixture.putFailure) throw new Error(fixture.putFailure)
    fixture.connected = [...fixture.connected, input.providerId]
  },
}))

const { AiStep } = await import("./ai-step")

function mount(localExecution: boolean) {
  const ready: boolean[] = []
  render(() => <AiStep baseUrl="https://plane.test" localExecution={localExecution} onReady={(value) => ready.push(value)} />)
  return ready
}

afterEach(() => {
  fixture.connected = []
  fixture.setConnected([])
  fixture.refreshes = 0
  fixture.puts = []
  fixture.putFailure = undefined
  fixture.runnable = {}
  fixture.catalogConnected = {}
  cleanup()
})

describe("AiStep on the hosted plane", () => {
  test("lists Pi's providers, stores a pasted key through the plane's auth route, and is ready once one is connected", async () => {
    const ready = mount(false)
    expect(ready.at(-1)).toBe(false)
    expect(document.querySelectorAll('[data-slot="onboarding-pi-providers"] li')).toHaveLength(3)
    expect(screen.getByText("Signs in from a CLI; no key to paste here")).toBeTruthy()

    const row = document.querySelector('[data-provider="anthropic"]')!
    fireEvent.click(row.querySelector("button")!)
    fireEvent.input(screen.getByLabelText("Anthropic API key"), { target: { value: "sk-ant-1" } })
    fireEvent.click(screen.getByRole("button", { name: "Save key" }))
    await waitFor(() => expect(fixture.puts).toEqual([{ serverUrl: "https://plane.test", providerId: "anthropic", harness: "pi", key: "sk-ant-1" }]))
    await waitFor(() => expect(ready.at(-1)).toBe(true))
    expect(fixture.refreshes).toBe(1)
    expect(row.getAttribute("data-connected")).toBe("true")
    expect(screen.queryByLabelText("Anthropic API key")).toBeNull()
  })

  test("the plane's refusal is shown as its own sentence and the step stays not ready", async () => {
    fixture.putFailure = "Hosted credentials are disabled"
    const ready = mount(false)
    fireEvent.click(document.querySelector('[data-provider="openai"] button')!)
    fireEvent.input(screen.getByLabelText("OpenAI API key"), { target: { value: "sk-1" } })
    fireEvent.click(screen.getByRole("button", { name: "Save key" }))
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Hosted credentials are disabled"))
    expect(ready.at(-1)).toBe(false)
    expect(fixture.refreshes).toBe(0)
  })
})

describe("AiStep on a desktop", () => {
  test("draws the Models page's rows and is ready when a harness can run or a catalog provider is connected", async () => {
    const ready = mount(true)
    expect(document.querySelector('[data-harness-row="claude"]')).toBeTruthy()
    expect(document.querySelector('[data-harness-row="codex"]')).toBeTruthy()
    expect(document.querySelector('[data-harness-row="cursor"]')).toBeTruthy()
    expect(document.querySelector('[data-providers-section="pi"]')).toBeTruthy()
    expect(document.querySelector('[data-providers-section="opencode"]')).toBeTruthy()
    expect(ready.at(-1)).toBe(false)
    cleanup()

    fixture.runnable = { codex: true }
    expect(mount(true).at(-1)).toBe(true)
    cleanup()

    fixture.runnable = {}
    fixture.catalogConnected = { opencode: ["anthropic"] }
    expect(mount(true).at(-1)).toBe(true)
  })
})
