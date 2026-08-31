/**
 * The UI half of the harness → provider-catalog contract.
 *
 * The server half (`packages/claxedo-server/src/agent-config/harness-provider-contract.test.ts`)
 * pins what `/provider?harness=` RETURNS. This file pins what the UI RENDERS for
 * each of those catalogs, and — the part that was never pinned — that the
 * catalog a dialog asks for is the one its harness context implies.
 *
 * `useProviders` is stubbed at the query seam so no network or SDK scope is
 * needed; the stub records the harness argument it was called with, which is
 * how the inheritance assertions are made.
 */
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  contractProviderIds,
  HARNESS_BINDING_HARNESS_IDS,
  HARNESS_BINDING_PROVIDER_IDS,
  OPENCODE_SAMPLE_PROVIDER_IDS,
  PI_PROVIDER_IDS,
  providerCatalogFixture,
} from "./test-support/harness-provider-contract"

const requestedHarnesses: Array<string | undefined> = []

vi.mock("@/app/providers/use-providers", async () => {
  const actual = await vi.importActual<typeof import("@/platform/query/provider-list")>(
    "@/platform/query/provider-list",
  )
  return {
    popularProviders: actual.popularProviders,
    useProviders: (harnessType?: string | (() => string | undefined)) => {
      const harness = typeof harnessType === "function" ? harnessType() : harnessType
      requestedHarnesses.push(harness)
      const catalog = providerCatalogFixture(contractProviderIds(harness))
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

const dialogState = vi.hoisted(() => ({ shown: [] as unknown[] }))

vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({
    show: (content: () => unknown) => {
      dialogState.shown.push(content())
    },
    close: () => undefined,
  }),
}))

const { CUSTOM_PROVIDER_ID, ProviderList } = await import("./provider-list")
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
  dialogState.shown.length = 0
})

afterEach(() => cleanup())

describe("ProviderList renders the contracted catalog per harness", () => {
  for (const harness of HARNESS_BINDING_HARNESS_IDS) {
    test(`harness=${harness} lists exactly the five harness-binding providers`, async () => {
      const { container } = render(() => <ProviderList harness={harness} onSelect={() => undefined} />)

      expect((await renderedProviderIdsWhenSettled(container)).sort())
        .toEqual([...HARNESS_BINDING_PROVIDER_IDS].sort())
      expect(requestedHarnesses).toContain(harness)
    })
  }

  test("harness=pi lists exactly pi's three launch providers", async () => {
    const { container } = render(() => <ProviderList harness="pi" onSelect={() => undefined} />)

    expect((await renderedProviderIdsWhenSettled(container)).sort()).toEqual([...PI_PROVIDER_IDS].sort())
  })

  test("no harness lists the models.dev catalog and adds the Custom provider entry", async () => {
    const { container } = render(() => <ProviderList onSelect={() => undefined} />)

    const ids = await renderedProviderIdsWhenSettled(container)
    for (const id of OPENCODE_SAMPLE_PROVIDER_IDS) expect(ids, id).toContain(id)
    // "Custom provider" is offered only in the harness-less catalog: a harness
    // catalog is a fixed set of bindings that a custom provider cannot join.
    expect(ids).toContain(CUSTOM_PROVIDER_ID)
    expect(requestedHarnesses).toContain(undefined)
  })

  test("a harness catalog never offers the Custom provider entry", async () => {
    const { container } = render(() => <ProviderList harness="pi" onSelect={() => undefined} />)

    expect(await renderedProviderIdsWhenSettled(container)).not.toContain(CUSTOM_PROVIDER_ID)
  })

  // The bug this whole matrix exists for: pi's three-provider catalog appearing
  // in a picker that is not pi's. Assert the sets are disjoint as rendered.
  test("the pi and harness-binding catalogs share no rendered provider", async () => {
    const pi = render(() => <ProviderList harness="pi" onSelect={() => undefined} />)
    const piIds = new Set(await renderedProviderIdsWhenSettled(pi.container))
    cleanup()

    const binding = render(() => <ProviderList harness="claude-sdk" onSelect={() => undefined} />)
    const bindingIds = await renderedProviderIdsWhenSettled(binding.container)

    expect(bindingIds.some((id) => piIds.has(id))).toBe(false)
  })
})

describe("the connect dialog inherits the harness it was opened with", () => {
  test("DialogSelectProvider passes its harness straight through to the catalog", async () => {
    render(() => <DialogSelectProvider harness="pi" />)
    await waitFor(() => expect(requestedHarnesses.length).toBeGreaterThan(0))
    expect(requestedHarnesses.every((harness) => harness === "pi")).toBe(true)
  })

  test("DialogSelectProvider with no harness asks for the full catalog", async () => {
    render(() => <DialogSelectProvider />)
    await waitFor(() => expect(requestedHarnesses.length).toBeGreaterThan(0))
    expect(requestedHarnesses.every((harness) => harness === undefined)).toBe(true)
  })

  test("selecting a provider carries the harness into the connect dialog", async () => {
    const { container } = render(() => <DialogSelectProvider harness="claude-sdk" />)
    await renderedProviderIdsWhenSettled(container)

    container.querySelector<HTMLElement>('[data-slot="list-item"][data-key="claude-sdk"]')!.click()

    await waitFor(() => expect(dialogState.shown.length).toBe(1))
    // The rendered connect dialog re-queries the catalog; it must ask for the
    // SAME harness, not drop back to the global one.
    expect(requestedHarnesses.at(-1)).toBe("claude-sdk")
  })
})
