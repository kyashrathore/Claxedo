import { describe, expect, test } from "bun:test"
import { ProviderConfigRoutes, disabledProviders, nextDisabledProviders, type ProviderConfigStore } from "./provider-config"
import { WorkspaceRuntimeRoutes } from "./manifest"

const ROUTE = `http://runtime.local${WorkspaceRuntimeRoutes.providerConfig}`

function memoryStore(initial: Record<string, unknown> = {}) {
  let document = { ...initial }
  const writes: Array<{ disabled_providers: string[] }> = []
  const store: ProviderConfigStore = {
    read: async () => ({ ...document }),
    write: async (patch) => {
      writes.push(patch)
      document = { ...document, ...patch }
      return { ...document }
    },
  }
  return { store, writes, current: () => ({ ...document }) }
}

function patch(app: ReturnType<typeof ProviderConfigRoutes>, input: {
  query?: string
  body?: unknown
}) {
  return app.request(`${ROUTE}${input.query ?? ""}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  })
}

describe("disabledProviders", () => {
  test("reads only the string entries a config document carries", () => {
    expect(disabledProviders({ disabled_providers: ["a", 3, "b"] })).toEqual(["a", "b"])
    expect(disabledProviders({})).toEqual([])
    expect(disabledProviders(null)).toEqual([])
    expect(disabledProviders({ disabled_providers: "a" })).toEqual([])
  })
})

describe("nextDisabledProviders", () => {
  test("adds once and removes completely, keeping the surviving order", () => {
    expect(nextDisabledProviders(["a", "b"], { provider: "c", disabled: true })).toEqual(["a", "b", "c"])
    expect(nextDisabledProviders(["a", "b"], { provider: "a", disabled: true })).toEqual(["b", "a"])
    expect(nextDisabledProviders(["a", "b", "a"], { provider: "a", disabled: false })).toEqual(["b"])
    expect(nextDisabledProviders([], { provider: "a", disabled: false })).toEqual([])
  })
})

describe("PATCH /api/wr/provider-config", () => {
  test("disables one provider in the named harness's config and answers the resulting list", async () => {
    const config = memoryStore({ provider: { "clinepass-2": { name: "Cline pass 2" } } })
    const harnesses: string[] = []
    const app = ProviderConfigRoutes({
      defaultHarness: () => "opencode",
      store: async (harness) => {
        harnesses.push(harness)
        return config.store
      },
    })

    const res = await patch(app, {
      query: "?harness=opencode&directory=workspace:ws_1",
      body: { provider: "clinepass-2", disabled: true },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ harness: "opencode", disabled_providers: ["clinepass-2"] })
    expect(harnesses).toEqual(["opencode"])
    expect(config.writes).toEqual([{ disabled_providers: ["clinepass-2"] }])
    // The declaration itself stays; only the disabled list changes.
    expect(config.current()).toEqual({
      provider: { "clinepass-2": { name: "Cline pass 2" } },
      disabled_providers: ["clinepass-2"],
    })
  })

  test("re-enabling drops the provider from the list", async () => {
    const config = memoryStore({ disabled_providers: ["clinepass-2", "kimi"] })
    const app = ProviderConfigRoutes({ defaultHarness: () => "opencode", store: async () => config.store })

    const res = await patch(app, { body: { provider: "clinepass-2", disabled: false } })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ harness: "opencode", disabled_providers: ["kimi"] })
  })

  test("repeating the same disconnect writes the same list", async () => {
    const config = memoryStore()
    const app = ProviderConfigRoutes({ defaultHarness: () => "opencode", store: async () => config.store })

    await patch(app, { body: { provider: "clinepass-2", disabled: true } })
    const second = await patch(app, { body: { provider: "clinepass-2", disabled: true } })

    expect(await second.json()).toEqual({ harness: "opencode", disabled_providers: ["clinepass-2"] })
    expect(config.writes).toEqual([
      { disabled_providers: ["clinepass-2"] },
      { disabled_providers: ["clinepass-2"] },
    ])
  })

  test("a request that names no harness is about the runtime's own", async () => {
    const config = memoryStore()
    const harnesses: string[] = []
    const app = ProviderConfigRoutes({
      defaultHarness: () => "opencode",
      store: async (harness) => {
        harnesses.push(harness)
        return config.store
      },
    })

    const res = await patch(app, { body: { provider: "clinepass-2", disabled: true } })

    expect(res.status).toBe(200)
    expect(harnesses).toEqual(["opencode"])
  })

  test("a harness that declares no providers is a 404, not a silent success", async () => {
    const app = ProviderConfigRoutes({ defaultHarness: () => "opencode", store: async () => undefined })

    const res = await patch(app, {
      query: "?harness=claude-sdk",
      body: { provider: "anthropic", disabled: true },
    })

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({
      error: { code: "provider_config_unsupported_harness" },
    })
  })

  test("a malformed body is rejected before anything is read or written", async () => {
    const config = memoryStore()
    let opened = 0
    const app = ProviderConfigRoutes({
      defaultHarness: () => "opencode",
      store: async () => {
        opened += 1
        return config.store
      },
    })

    for (const body of [{}, { provider: "" }, { provider: "a" }, { provider: 1, disabled: true }, { provider: "a", disabled: "yes" }]) {
      const res = await patch(app, { body })
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: { code: "provider_config_invalid_request" } })
    }
    expect(opened).toBe(0)
    expect(config.writes).toEqual([])
  })

  test("an unreachable config surfaces as an explicit failure, never as an empty list", async () => {
    const app = ProviderConfigRoutes({
      defaultHarness: () => "opencode",
      store: async () => ({
        read: async () => {
          throw new Error("opencode configuration request failed with status 503")
        },
        write: async () => ({}),
      }),
    })

    const res = await patch(app, { body: { provider: "clinepass-2", disabled: true } })

    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({
      error: {
        code: "provider_config_unavailable",
        message: "opencode configuration request failed with status 503",
      },
    })
  })
})
