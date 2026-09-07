/** Renderer-only provider rows and dialog handoff; real transport tests live with useProviders. */
import { cleanup, render, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
const PI_PROVIDER_IDS = ["anthropic", "openai", "openai-codex"]

const requestedHarnesses: Array<string | undefined> = []
const requestedScopes: Array<string | undefined> = []

vi.mock("@/app/providers/use-providers", async () => {
  const actual = await vi.importActual<typeof import("@/platform/query/provider-list")>(
    "@/platform/query/provider-list",
  )
  return {
    popularProviders: actual.popularProviders,
    useProviders: (harnessType: string | (() => string), scope?: string | (() => string | undefined)) => {
      const harness = typeof harnessType === "function" ? harnessType() : harnessType
      requestedHarnesses.push(harness)
      requestedScopes.push(typeof scope === "function" ? scope() : scope)
      const catalog = { all: PI_PROVIDER_IDS.map((id) => ({ id, name: id, models: {} })) }
      const all = new Map(catalog.all.map((provider) => [provider.id, provider] as const))
      return {
        state: () => ({ all, connected: [], default: {} }),
        loading: () => false,
        error: () => undefined,
        refresh: () => undefined,
        load: async () => undefined,
        all: () => all,
        default: () => ({}),
        popular: () => [],
        connected: () => [],
      }
    },
  }
})

vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({ t: (key: string) => key, locale: () => "en" }),
}))

// The dialog SHELL is chrome, not contract: Kobalte's `Dialog.Content` needs a
// mounted `Dialog.Root` context that these tests have no reason to provide.
// What matters here is the catalog it wraps, so render the shell as a plain box.
vi.mock("@opencode-ai/ui/dialog", () => ({
  Dialog: (props: { children?: unknown }) => <div data-component="dialog">{props.children as never}</div>,
}))

// The connect FORM owns the credential flow and needs the GlobalSDK scope; the
// harness hand-off happens above it, in `DialogConnectProvider`, which stays
// real so its own `useProviders(props.harness)` call is what gets recorded.
vi.mock("./provider-connect-form", () => ({
  ProviderConnectForm: () => <div data-component="provider-connect-form" />,
}))

// The custom-provider dialog owns a mutation and a credential write of its own,
// tested with it. Here only the hand-off is contract.
vi.mock("./custom-provider", () => ({
  DialogCustomProvider: () => <div data-component="custom-provider-dialog" />,
}))

const dialogState = vi.hoisted(() => ({ shown: [] as unknown[] }))

vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({
    show: (content: () => unknown) => {
      dialogState.shown.push(content())
    },
    close: () => undefined,
  }),
}))

const { ProviderList } = await import("./provider-list")
const { DialogSelectProvider } = await import("./select-provider")

/** The provider rows the list actually rendered, by id. `List` stamps each row
 * with the `key` the caller supplies, and `ProviderList` keys by provider id. */
function renderedProviderIds(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>("[data-slot=list-item][data-key]")]
    .map((node) => node.getAttribute("data-key") ?? "")
    .filter(Boolean)
}

/** The row list settles asynchronously — `useFilteredList` runs its grouping
 * through a `createResource`, so the first paint is the "Loading" empty state. */
async function renderedProviderIdsWhenSettled(container: HTMLElement) {
  await waitFor(() => expect(renderedProviderIds(container).length).toBeGreaterThan(0))
  return renderedProviderIds(container)
}

beforeEach(() => {
  requestedHarnesses.length = 0
  requestedScopes.length = 0
  dialogState.shown.length = 0
})

afterEach(() => cleanup())

describe("ProviderList renderer", () => {
  test("renders exactly the provided native catalog without a custom registry row", async () => {
    const { container } = render(() => <ProviderList harness="pi" onSelect={() => undefined} />)
    expect((await renderedProviderIdsWhenSettled(container)).sort()).toEqual([...PI_PROVIDER_IDS].sort())
    expect(container.querySelector('[data-key="_custom"]')).toBeNull()
  })

  test("adds the custom entry to the OpenCode catalog, ahead of the rest of its group", async () => {
    const { container } = render(() => <ProviderList harness="opencode" onSelect={() => undefined} />)
    const ids = await renderedProviderIdsWhenSettled(container)
    expect([...ids].sort()).toEqual(["_custom", ...PI_PROVIDER_IDS].sort())
    // "anthropic" and "openai" are popular, so the custom entry's neighbours
    // are the rest; it leads them.
    expect(ids.indexOf("_custom")).toBeLessThan(ids.indexOf("openai-codex"))
  })
})

describe("the connect dialog inherits the harness it was opened with", () => {
  test("DialogSelectProvider passes its harness straight through to the catalog", async () => {
    render(() => <DialogSelectProvider harness="pi" />)
    await waitFor(() => expect(requestedHarnesses.length).toBeGreaterThan(0))
    expect(requestedHarnesses.every((harness) => harness === "pi")).toBe(true)
  })

  test("the workspace scope rides down with the harness", async () => {
    render(() => <DialogSelectProvider harness="pi" scope="workspace:ws_1" />)
    await waitFor(() => expect(requestedScopes.length).toBeGreaterThan(0))
    expect(requestedScopes.every((scope) => scope === "workspace:ws_1")).toBe(true)
  })

  test("selecting a provider carries the workspace scope into the connect dialog", async () => {
    const { container } = render(() => <DialogSelectProvider harness="pi" scope="workspace:ws_1" />)
    await renderedProviderIdsWhenSettled(container)

    container.querySelector<HTMLElement>('[data-slot="list-item"][data-key="anthropic"]')!.click()

    await waitFor(() => expect(dialogState.shown.length).toBe(1))
    expect(requestedScopes.at(-1)).toBe("workspace:ws_1")
  })

  test("selecting the custom entry opens the custom-provider dialog, not the connect form", async () => {
    const { container } = render(() => <DialogSelectProvider harness="opencode" scope="workspace:ws_1" />)
    await renderedProviderIdsWhenSettled(container)

    container.querySelector<HTMLElement>('[data-slot="list-item"][data-key="_custom"]')!.click()

    await waitFor(() => expect(dialogState.shown.length).toBe(1))
    expect(document.body.querySelector('[data-component="provider-connect-form"]')).toBeNull()
  })

  test("selecting a provider carries the harness into the connect dialog", async () => {
    const { container } = render(() => <DialogSelectProvider harness="pi" />)
    await renderedProviderIdsWhenSettled(container)

    container.querySelector<HTMLElement>('[data-slot="list-item"][data-key="anthropic"]')!.click()

    await waitFor(() => expect(dialogState.shown.length).toBe(1))
    // The rendered connect dialog re-queries the catalog; it must ask for the
    // SAME harness, not drop back to the global one.
    expect(requestedHarnesses.at(-1)).toBe("pi")
  })
})
