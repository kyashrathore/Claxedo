/** The custom-provider dialog against the real form, validation and save path. */
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const state = vi.hoisted(() => ({
  catalog: ["anthropic"],
  credentialWrites: [] as unknown[],
  configWrites: [] as Array<{ url: string; body: unknown }>,
  configStatus: 200,
  closed: 0,
  invalidated: 0,
}))

const jsonBody = (init?: RequestInit): unknown =>
  JSON.parse(typeof init?.body === "string" ? init.body : "null")

vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({ t: (key: string) => key, locale: () => "en" }),
}))
vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({ show: () => undefined, close: () => { state.closed += 1 } }),
}))
vi.mock("@opencode-ai/ui/dialog", () => ({
  Dialog: (props: { children?: unknown }) => <div data-component="dialog">{props.children as never}</div>,
}))
vi.mock("@opencode-ai/ui/provider-icon", () => ({ ProviderIcon: () => <span /> }))
vi.mock("@opencode-ai/ui/toast", () => ({ showToast: () => undefined }))
vi.mock("@/app/controls/link", () => ({ Link: (props: { children?: unknown }) => <a>{props.children as never}</a> }))
vi.mock("@/app/providers/use-providers", () => ({
  useProviders: () => ({
    all: () => new Map(state.catalog.map((id) => [id, { id, name: id, models: {} }] as const)),
    load: async () => undefined,
  }),
}))
vi.mock("@/platform/api/credential-request", () => ({
  claxedoCredentialRequest: async (_input: unknown, init: RequestInit) => {
    state.credentialWrites.push(jsonBody(init))
    return new Response("{}", { status: 200 })
  },
}))
vi.mock("@/platform/query/query-client", () => ({
  queryClient: { invalidateQueries: async () => { state.invalidated += 1 } },
}))
vi.mock("@/platform/api/api", async (original) => ({
  ...(await original<typeof import("@/platform/api/api")>()),
  getClaxedoServerUrl: () => "http://server.test",
  authFetch: async (url: URL, init?: RequestInit) => {
    state.configWrites.push({ url: url.toString(), body: jsonBody(init) })
    return new Response(state.configStatus === 200 ? "{}" : "nope", { status: state.configStatus })
  },
}))

const { DialogCustomProvider } = await import("./custom-provider")
const { removeCustomProviderConfig } = await import("./custom-provider-logic")

beforeEach(() => {
  state.catalog = ["anthropic"]
  state.credentialWrites.length = 0
  state.configWrites.length = 0
  state.configStatus = 200
  state.closed = 0
  state.invalidated = 0
})

afterEach(cleanup)

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(() => (
    <QueryClientProvider client={client}>
      <DialogCustomProvider />
    </QueryClientProvider>
  ))
}

function found<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`no ${what}`)
  return value
}

function field(container: HTMLElement, index: number) {
  return found([...container.querySelectorAll<HTMLInputElement>("input")][index], `input ${index}`)
}

function type(container: HTMLElement, index: number, value: string) {
  const input = field(container, index)
  fireEvent.input(input, { target: { value } })
  fireEvent.change(input, { target: { value } })
}

function submit(container: HTMLElement) {
  fireEvent.submit(found(container.querySelector("form"), "form"))
}

function click(container: HTMLElement, label: string) {
  const buttons = [...container.querySelectorAll<HTMLElement>("button")]
  fireEvent.click(found(buttons.find((node) => node.textContent?.includes(label)), label))
}

/** providerID, name, baseURL, apiKey, key header, model id, model name, header key, header value. */
const VALID = ["acme", "Acme", "https://api.acme.test/v1", "sk-live", "Authorization", "acme-1", "Acme One", "X-Title", "prod"]

function fill(container: HTMLElement, values: readonly string[]) {
  values.forEach((value, index) => type(container, index, value))
}

const SAVED = {
  url: "http://server.test/api/claxedo/agent-config/providers/custom?nativeHarness=opencode",
  body: {
    providerID: "acme",
    name: "Acme",
    baseURL: "https://api.acme.test/v1",
    env: [],
    headers: { "X-Title": "prod" },
    credentialHeader: { name: "Authorization", scheme: "Bearer" },
    models: { "acme-1": { name: "Acme One" } },
  },
}

describe("DialogCustomProvider", () => {
  test("saves the credential and the configuration, then closes and refreshes the catalog", async () => {
    const { container } = mount()
    fill(container, VALID)
    submit(container)

    await waitFor(() => expect(state.configWrites).toEqual([SAVED]))
    expect(state.credentialWrites).toEqual([
      { provider_id: "acme", kind: "api_key", source: "managed", label: "Acme", secret: "sk-live" },
    ])
    await waitFor(() => expect(state.closed).toBe(1))
    expect(state.invalidated).toBe(1)
  })

  test("added model and header rows round-trip into the saved configuration", async () => {
    const { container } = mount()
    fill(container, VALID)
    click(container, "provider.custom.models.add")
    click(container, "provider.custom.headers.add")
    type(container, 7, "acme-2")
    type(container, 8, "Acme Two")
    type(container, 11, "OpenAI-Project")
    type(container, 12, "proj-1")
    submit(container)

    await waitFor(() => expect(state.configWrites).toEqual([{
      url: SAVED.url,
      body: {
        ...SAVED.body,
        headers: { "X-Title": "prod", "OpenAI-Project": "proj-1" },
        models: { "acme-1": { name: "Acme One" }, "acme-2": { name: "Acme Two" } },
      },
    }]))
  })

  test("an api key written as {env:VAR} names the variable instead of storing a secret", async () => {
    const { container } = mount()
    fill(container, [...VALID.slice(0, 3), "{env:ACME_API_KEY}", ...VALID.slice(4)])
    submit(container)

    await waitFor(() => expect(state.configWrites).toEqual([{ url: SAVED.url, body: { ...SAVED.body, env: ["ACME_API_KEY"] } }]))
    expect(state.credentialWrites).toEqual([])
  })

  test("a named key header is saved as the header the broker writes the key into, with no Bearer scheme", async () => {
    const { container } = mount()
    fill(container, [...VALID.slice(0, 4), "X-Goog-Api-Key", ...VALID.slice(5)])
    submit(container)

    await waitFor(() => expect(state.configWrites).toEqual([{ url: SAVED.url,
      body: { ...SAVED.body, credentialHeader: { name: "X-Goog-Api-Key" } } }]))
  })

  test.each([["a metadata header", "X-Title"], ["a header the connection owns", "Cookie"], ["an empty header", ""]])(
    "%s as the key header is refused before anything is written", async (_label, keyHeader) => {
      const { container } = mount()
      fill(container, [...VALID.slice(0, 4), keyHeader, ...VALID.slice(5)])
      submit(container)

      await waitFor(() => expect(screen.getByText(keyHeader ? "provider.custom.error.keyHeader.invalid" : "provider.custom.error.required")).toBeTruthy())
      expect(state.credentialWrites).toEqual([])
      expect(state.configWrites).toEqual([])
    })

  test("a request header outside the metadata allow-list is refused before anything is written", async () => {
    const { container } = mount()
    fill(container, [...VALID.slice(0, 7), "X-Auth-Token", "secret"])
    submit(container)

    await waitFor(() => expect(screen.getByText("provider.custom.error.header.metadata")).toBeTruthy())
    expect(state.credentialWrites).toEqual([])
    expect(state.configWrites).toEqual([])
  })

  test("a provider id already in the OpenCode catalog is refused before anything is written", async () => {
    state.catalog = ["anthropic", "acme"]
    const { container } = mount()
    fill(container, VALID)
    submit(container)

    await waitFor(() => expect(screen.getByText("provider.custom.error.providerID.exists")).toBeTruthy())
    expect(state.credentialWrites).toEqual([])
    expect(state.configWrites).toEqual([])
    expect(state.closed).toBe(0)
  })

  test("a duplicate model id is refused before anything is written", async () => {
    const { container } = mount()
    fill(container, VALID)
    click(container, "provider.custom.models.add")
    type(container, 7, "acme-1")
    type(container, 8, "Acme One Again")
    submit(container)

    await waitFor(() => expect(screen.getByText("provider.custom.error.duplicate")).toBeTruthy())
    expect(state.configWrites).toEqual([])
  })

  test("a rejected configuration write leaves the dialog open", async () => {
    state.configStatus = 400
    const { container } = mount()
    fill(container, VALID)
    submit(container)

    await waitFor(() => expect(state.configWrites).toHaveLength(1))
    expect(state.closed).toBe(0)
    expect(state.invalidated).toBe(0)
  })

  test("removing a declared provider deletes its declaration on the control plane", async () => {
    await removeCustomProviderConfig({ providerId: "acme" })
    expect(state.configWrites).toEqual([{ url: "http://server.test/api/claxedo/agent-config/providers/custom/acme?nativeHarness=opencode", body: null }])
  })
})
