/** The connect form explains each of a vendor's sign-in methods before it asks for anything. */
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"

const state = vi.hoisted(() => ({
  methods: [] as Array<{ type: "oauth" | "api" | "token"; label: string; command?: string }>,
  puts: [] as Array<{ input: unknown; body: Record<string, unknown> }>,
  authorized: [] as Array<{ providerID: string; method: number }>,
  opened: [] as string[],
}))

/** The methods the server lists for a vendor, in the order it lists them. */
const ANTHROPIC_METHODS = [
  { type: "token" as const, label: "Claude subscription token", command: "claude setup-token" },
  { type: "api" as const, label: "API Key" },
]
const OPENAI_METHODS = [
  { type: "api" as const, label: "API Key" },
  { type: "oauth" as const, label: "ChatGPT Pro/Plus (headless)" },
]

vi.mock("@/app/providers/global-sdk/provider", () => ({
  useGlobalSDK: () => ({
    url: "http://127.0.0.1:2593",
    client: {
      provider: {
        oauth: {
          authorize: async (input: { providerID: string; method: number }) => {
            state.authorized.push(input)
            return { data: undefined }
          },
          callback: async () => undefined,
        },
      },
    },
  }),
}))
vi.mock("@/app/providers/use-providers", () => ({
  useProviders: () => ({
    all: () => new Map([["claude-sdk", { id: "claude-sdk", name: "Claude", source: "api", env: [], options: {}, models: {} }]]),
    load: async () => undefined,
  }),
  useProviderAuth: () => ({
    get data() {
      return {
        "claude-sdk": state.methods,
        "codex-app-server": state.methods,
        "anthropic": state.methods,
        "moonshot": state.methods,
      }
    },
  }),
}))
vi.mock("@/platform/api/credential-request", () => ({
  claxedoCredentialRequest: async (input: unknown, init?: RequestInit) => {
    state.puts.push({ input, body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") })
    return new Response(JSON.stringify({ credential: { id: "cred_1", provider_id: "claude-sdk" } }), { headers: { "Content-Type": "application/json" } })
  },
}))
vi.mock("@/platform/query/query-client", () => ({ queryClient: { invalidateQueries: async () => undefined } }))
vi.mock("@opencode-ai/ui/toast", () => ({ showToast: () => undefined }))
vi.mock("@opencode-ai/ui/provider-icon", () => ({ ProviderIcon: () => null }))
vi.mock("@/platform/runtime/platform-provider", () => ({
  usePlatform: () => ({ openLink: (href: string) => state.opened.push(href) }),
}))
vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({
    t: (key: string, vars?: Record<string, string>) => (vars ? `${key}:${Object.values(vars).join("|")}` : key),
    locale: () => "en",
  }),
}))

const { ProviderConnectForm } = await import("./provider-connect-form")
const { engineConnectContext, harnessConnectContext } = await import("@/platform/identity/harness-catalog")

afterEach(() => {
  cleanup()
  state.puts.length = 0
  state.authorized.length = 0
  state.opened.length = 0
})

/** The card's option titles, in the order a reader sees them. */
function optionTitles() {
  return [...document.querySelectorAll('[data-component="provider-connect-methods"] > *')]
    .map((node) => node.firstElementChild?.textContent ?? "")
}

function option(type: string) {
  return document.querySelector<HTMLElement>(`[data-action="provider-connect-method"][data-method-type="${type}"]`)!
}

describe("ProviderConnectForm method chooser", () => {
  test("Anthropic offers the subscription token first and the console key second, each explained", async () => {
    state.methods = [...ANTHROPIC_METHODS]
    render(() => <ProviderConnectForm provider="claude-sdk" context={harnessConnectContext("claude")} harness="claude" hideHeading />)

    await waitFor(() => expect(optionTitles()).toHaveLength(2))
    expect(optionTitles()).toEqual([
      "provider.connect.method.anthropic.subscription.title:Claude Code|Anthropic",
      "provider.connect.method.anthropic.apiKey.title:Claude Code|Anthropic",
    ])
    const body = document.body.textContent ?? ""
    expect(body).toContain("provider.connect.method.anthropic.subscription.for:Claude Code|Anthropic")
    expect(body).toContain("provider.connect.method.anthropic.subscription.how:Claude Code|Anthropic")
    expect(body).toContain("provider.connect.method.anthropic.apiKey.for:Claude Code|Anthropic")
    expect(body).toContain("provider.connect.method.anthropic.apiKey.how:Claude Code|Anthropic")
    // Nothing is picked yet, so there is no field to fill in.
    expect(document.querySelector("form")).toBeNull()
  })

  test("picking the subscription token shows the command that mints it and keeps the explanation on screen", async () => {
    state.methods = [...ANTHROPIC_METHODS]
    render(() => <ProviderConnectForm provider="claude-sdk" context={harnessConnectContext("claude")} harness="claude" hideHeading />)
    await waitFor(() => expect(optionTitles()).toHaveLength(2))

    fireEvent.click(option("token"))

    await waitFor(() => expect(document.querySelector('form[data-method="token"]')).not.toBeNull())
    expect(screen.getByDisplayValue("claude setup-token")).toBeInTheDocument()
    expect(option("token").getAttribute("aria-checked")).toBe("true")
    expect(option("api").getAttribute("aria-checked")).toBe("false")
    expect(document.body.textContent)
      .toContain("provider.connect.method.anthropic.subscription.how:Claude Code|Anthropic")
    // The key page belongs to the other method, which is not the one selected.
    expect(screen.queryByText("provider.connect.method.openKeyPage")).toBeNull()
  })

  test("picking the API key shows the vendor's key page, opened outside the app", async () => {
    state.methods = [...ANTHROPIC_METHODS]
    render(() => <ProviderConnectForm provider="claude-sdk" context={harnessConnectContext("claude")} harness="claude" hideHeading />)
    await waitFor(() => expect(optionTitles()).toHaveLength(2))

    fireEvent.click(option("api"))

    await waitFor(() => expect(document.querySelector('form[data-method="api"]')).not.toBeNull())
    expect(screen.queryByDisplayValue("claude setup-token")).toBeNull()
    fireEvent.click(screen.getByText("provider.connect.method.openKeyPage"))
    expect(state.opened).toEqual(["https://platform.claude.com/settings/keys"])
  })

  test("OpenAI offers the ChatGPT plan first, and signing in authorizes the method the server indexed", async () => {
    // The server lists the key first; the card leads with the plan, so the
    // index the plan card signs in with is not the index it is drawn at.
    state.methods = [...OPENAI_METHODS]
    render(() => <ProviderConnectForm provider="codex-app-server" context={harnessConnectContext("codex")} harness="codex" hideHeading />)
    await waitFor(() => expect(optionTitles()).toHaveLength(2))

    expect(optionTitles()).toEqual([
      "provider.connect.method.openai.plan.title:Codex|OpenAI",
      "provider.connect.method.openai.apiKey.title:Codex|OpenAI",
    ])

    fireEvent.click(option("oauth"))
    await waitFor(() => expect(document.querySelector('[data-action="provider-connect-oauth-start"]')).not.toBeNull())
    fireEvent.click(document.querySelector<HTMLElement>('[data-action="provider-connect-oauth-start"]')!)

    await waitFor(() => expect(state.authorized).toHaveLength(1))
    expect(state.authorized[0]).toEqual({ providerID: "codex-app-server", method: 1 })
  })

  test("a harness whose server serves no method list still offers what the reader can paste", async () => {
    // A vendor the server serves no method list for: everything the reader
    // pastes is named here, so the card is still usable without an answer.
    state.methods = []
    render(() => <ProviderConnectForm provider="claude-sdk" context={harnessConnectContext("claude")} harness="claude" hideHeading />)

    await waitFor(() => expect(optionTitles()).toHaveLength(2))
    expect(optionTitles()).toEqual([
      "provider.connect.method.anthropic.subscription.title:Claude Code|Anthropic",
      "provider.connect.method.anthropic.apiKey.title:Claude Code|Anthropic",
    ])

    fireEvent.click(option("token"))

    await waitFor(() => expect(document.querySelector('form[data-method="token"]')).not.toBeNull())
    expect(screen.getByDisplayValue("claude setup-token")).toBeInTheDocument()
  })

  test("a vendor the catalog has never heard of is explained in its own name", async () => {
    state.methods = [{ type: "api", label: "API Key" }]
    render(() => <ProviderConnectForm provider="moonshot" context={engineConnectContext("pi", "Moonshot")} harness="pi" hideHeading />)

    await waitFor(() => expect(document.querySelector('form[data-method="api"]')).not.toBeNull())
    expect(optionTitles()).toEqual(["provider.connect.method.generic.apiKey.title:Pi|Moonshot"])
    expect(document.body.textContent).toContain("provider.connect.method.generic.apiKey.how:Pi|Moonshot")
    // One method is not a choice, so it is stated rather than offered.
    expect(document.querySelector('[data-action="provider-connect-method"]')).toBeNull()
    expect(document.querySelector('[data-component="provider-connect-methods"]')?.getAttribute("role")).toBeNull()
  })

  test("the card says what connecting will do, in the words of the surface that opened it", async () => {
    state.methods = [{ type: "api", label: "API Key" }]
    const view = render(() => <ProviderConnectForm provider="claude-sdk" context={harnessConnectContext("claude")} harness="claude" hideHeading />)
    await waitFor(() => expect(document.querySelector('form[data-method="api"]')).not.toBeNull())
    expect(document.body.textContent).toContain("provider.connect.context.harness:Claude Code|Anthropic")
    expect(document.body.textContent).not.toContain("claude-sdk")
    view.unmount()

    render(() => <ProviderConnectForm provider="anthropic" context={engineConnectContext("pi", "Anthropic")} harness="pi" hideHeading />)
    await waitFor(() => expect(document.querySelector('form[data-method="api"]')).not.toBeNull())
    expect(document.body.textContent).toContain("provider.connect.context.engine:Pi|Anthropic")
  })

  test("a segmented picker opens on the first method rather than asking twice", async () => {
    state.methods = [...OPENAI_METHODS]
    render(() => (
      <ProviderConnectForm provider="codex-app-server" context={harnessConnectContext("codex")} harness="codex" hideHeading preselectFirstMethod />
    ))

    await waitFor(() => expect(document.querySelector('[data-action="provider-connect-oauth-start"]')).not.toBeNull())
    expect(option("oauth").getAttribute("aria-checked")).toBe("true")
    expect(document.querySelector("form")).toBeNull()
    expect(state.authorized).toEqual([])

    fireEvent.click(option("api"))

    await waitFor(() => expect(document.querySelector('form[data-method="api"]')).not.toBeNull())
    expect(document.querySelector('[data-action="provider-connect-oauth-start"]')).toBeNull()
  })
})

describe("ProviderConnectForm storage", () => {
  test("a pasted subscription token is stored under the name the user gave it", async () => {
    state.methods = [...ANTHROPIC_METHODS]
    render(() => <ProviderConnectForm provider="claude-sdk" context={harnessConnectContext("claude")} harness="claude" hideHeading />)
    await waitFor(() => expect(optionTitles()).toHaveLength(2))
    fireEvent.click(option("token"))
    await waitFor(() => expect(document.querySelector('form[data-method="token"]')).not.toBeNull())

    const input = document.querySelector<HTMLInputElement>('input[name="apiKey"]')!
    fireEvent.input(input, { target: { value: "sk-ant-oat01-example" } })
    fireEvent.input(document.querySelector<HTMLInputElement>('input[name="accountLabel"]')!, { target: { value: "work@acme.com" } })
    fireEvent.submit(input.closest("form")!)

    await waitFor(() => expect(state.puts).toHaveLength(1))
    expect(state.puts[0].body).toMatchObject({ provider_id: "claude-sdk", kind: "api_key", secret: "sk-ant-oat01-example", label: "work@acme.com" })
  })

  test("a pasted credential will not be stored under a name that does not identify the account", async () => {
    state.methods = [{ type: "api", label: "API Key" }]
    render(() => <ProviderConnectForm provider="claude-sdk" context={harnessConnectContext("claude")} harness="claude" hideHeading />)
    await waitFor(() => expect(document.querySelector('form[data-method="api"]')).not.toBeNull())

    const input = document.querySelector<HTMLInputElement>('input[name="apiKey"]')!
    fireEvent.input(input, { target: { value: "sk-ant-example" } })
    fireEvent.submit(input.closest("form")!)

    await waitFor(() => expect(screen.getByText("provider.connect.label.required")).toBeInTheDocument())
    expect(state.puts).toEqual([])
  })

  test("reconnecting replaces the token on the named row and asks for no new name", async () => {
    state.methods = [{ type: "api", label: "API Key" }]
    render(() => <ProviderConnectForm provider="claude-sdk" context={harnessConnectContext("claude")} harness="claude" credentialId="cred_bad" hideHeading />)
    await waitFor(() => expect(document.querySelector('form[data-method="api"]')).not.toBeNull())
    // The row keeps the name it already has, so there is nothing to ask for.
    expect(document.querySelector('input[name="accountLabel"]')).toBeNull()

    const input = document.querySelector<HTMLInputElement>('input[name="apiKey"]')!
    fireEvent.input(input, { target: { value: "sk-ant-fresh" } })
    fireEvent.submit(input.closest("form")!)

    await waitFor(() => expect(state.puts).toHaveLength(1))
    expect(state.puts[0].input).toEqual({ credentialId: "cred_bad", action: "reconnect" })
    expect(state.puts[0].body).toEqual({ secret: "sk-ant-fresh" })
  })
})
