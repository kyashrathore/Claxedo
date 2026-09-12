/** The connect form offers every method the server names and pastes a token the same way as a key. */
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"

const state = vi.hoisted(() => ({
  methods: [] as Array<{ type: "oauth" | "api" | "token"; label: string; command?: string }>,
  puts: [] as Array<Record<string, unknown>>,
}))

vi.mock("@/app/providers/global-sdk/provider", () => ({
  useGlobalSDK: () => ({ url: "http://127.0.0.1:2593", client: { provider: { oauth: { authorize: async () => ({ data: undefined }), callback: async () => undefined } } } }),
}))
vi.mock("@/app/providers/use-providers", () => ({
  useProviders: () => ({
    all: () => new Map([["claude-sdk", { id: "claude-sdk", name: "Claude", source: "api", env: [], options: {}, models: {} }]]),
    load: async () => undefined,
  }),
  useProviderAuth: () => ({ get data() { return { "claude-sdk": state.methods } } }),
}))
vi.mock("@/platform/api/credential-request", () => ({
  claxedoCredentialRequest: async (_input: unknown, init?: RequestInit) => {
    state.puts.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}"))
    return new Response(JSON.stringify({ credential: { id: "cred_1", provider_id: "claude-sdk" } }), { headers: { "Content-Type": "application/json" } })
  },
}))
vi.mock("@/platform/query/query-client", () => ({ queryClient: { invalidateQueries: async () => undefined } }))
vi.mock("@opencode-ai/ui/toast", () => ({ showToast: () => undefined }))
vi.mock("@opencode-ai/ui/provider-icon", () => ({ ProviderIcon: () => null }))
vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({
    t: (key: string, vars?: Record<string, string>) => (vars ? `${key}:${Object.values(vars).join("|")}` : key),
    locale: () => "en",
  }),
}))

const { ProviderConnectForm } = await import("./provider-connect-form")

afterEach(() => {
  cleanup()
  state.puts.length = 0
})

describe("ProviderConnectForm", () => {
  test("a subscription token is offered beside the API key, with the command that mints it", async () => {
    state.methods = [
      { type: "token", label: "Claude subscription token", command: "claude setup-token" },
      { type: "api", label: "API Key" },
    ]
    render(() => <ProviderConnectForm provider="claude-sdk" harness="claude" hideHeading />)
    await waitFor(() => expect(screen.getByText("Claude subscription token")).toBeInTheDocument())
    expect(screen.getByText("provider.connect.method.apiKey")).toBeInTheDocument()

    fireEvent.click(screen.getByText("Claude subscription token"))
    await waitFor(() => expect(document.querySelector('form[data-method="token"]')).not.toBeNull())
    expect(screen.getByText("provider.connect.token.description:Claude")).toBeInTheDocument()
    expect(screen.getByDisplayValue("claude setup-token")).toBeInTheDocument()

    const input = document.querySelector<HTMLInputElement>('input[name="apiKey"]')!
    fireEvent.input(input, { target: { value: "sk-ant-oat01-example" } })
    fireEvent.submit(input.closest("form")!)
    await waitFor(() => expect(state.puts).toHaveLength(1))
    expect(state.puts[0]).toMatchObject({ provider_id: "claude-sdk", kind: "api_key", secret: "sk-ant-oat01-example" })
  })

  test("a harness with several methods lists them all instead of assuming a key", async () => {
    state.methods = [
      { type: "oauth", label: "ChatGPT Pro/Plus (headless)" },
      { type: "api", label: "API Key" },
    ]
    render(() => <ProviderConnectForm provider="claude-sdk" harness="codex" hideHeading />)
    await waitFor(() => expect(screen.getByText("ChatGPT Pro/Plus (headless)")).toBeInTheDocument())
    expect(document.querySelector("form")).toBeNull()
  })
})

describe("ProviderConnectForm with a segmented picker", () => {
  test("keeps every method on screen, starts on the first, and waits for a click before signing in", async () => {
    state.methods = [
      { type: "oauth", label: "ChatGPT Pro/Plus (headless)" },
      { type: "api", label: "API Key" },
    ]
    render(() => <ProviderConnectForm provider="claude-sdk" harness="codex" hideHeading methodPicker="segmented" />)
    await waitFor(() => expect(document.querySelectorAll('[data-action="provider-connect-method"]')).toHaveLength(2))
    expect(document.querySelector('[data-action="provider-connect-oauth-start"]')).not.toBeNull()
    expect(document.querySelector("form")).toBeNull()

    const segments = document.querySelectorAll<HTMLButtonElement>('[data-action="provider-connect-method"]')
    expect(segments[0].getAttribute("aria-selected")).toBe("true")
    fireEvent.click(segments[1])
    await waitFor(() => expect(document.querySelector('form[data-method="api"]')).not.toBeNull())
    expect(document.querySelector('[data-action="provider-connect-oauth-start"]')).toBeNull()
    expect(segments[1].getAttribute("aria-selected")).toBe("true")
  })
})
