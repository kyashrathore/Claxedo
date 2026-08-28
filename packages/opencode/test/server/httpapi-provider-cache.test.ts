import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { mapValues } from "remeda"
import { Provider } from "@/provider/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { ModelsDev } from "@opencode-ai/core/models-dev"
import {
  buildListResult,
  providerListBody,
  ProviderListCacheInternals,
  type ProviderListInputs,
} from "../../src/server/routes/instance/httpapi/handlers/provider-list-cache"
import { resetDatabase } from "../fixture/db"
import { reloadInstance, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, request } from "./httpapi-layer"

const MODELS_FIXTURE = JSON.parse(
  await Bun.file(path.join(import.meta.dir, "..", "tool", "fixtures", "models-api.json")).text(),
) as Record<string, ModelsDev.Provider>

function makeInputs(overrides: Partial<ProviderListInputs> = {}): ProviderListInputs {
  const all = structuredClone({
    anthropic: MODELS_FIXTURE["anthropic"],
    openai: MODELS_FIXTURE["openai"],
  }) as Record<string, ModelsDev.Provider>
  const catalog = mapValues(all, (item) => Provider.fromModelsDevProvider(item)) as Record<
    ProviderV2.ID,
    Provider.Info
  >
  return {
    all,
    catalog,
    connected: {},
    config: {},
    ...overrides,
  }
}

/** Same content, all-new object identities — the shape of a fresh process or a rebuilt instance state. */
function cloneInputs(inputs: ProviderListInputs): ProviderListInputs {
  return structuredClone(inputs)
}

const fullList = { selectedProvider: null, indexOnly: false }

function counters() {
  return {
    encodes: ProviderListCacheInternals.encodes,
    diskHits: ProviderListCacheInternals.diskHits,
    diskWrites: ProviderListCacheInternals.diskWrites,
  }
}

function delta(before: ReturnType<typeof counters>) {
  const now = counters()
  return {
    encodes: now.encodes - before.encodes,
    diskHits: now.diskHits - before.diskHits,
    diskWrites: now.diskWrites - before.diskWrites,
  }
}

async function tmpCacheDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "opencode-provider-list-cache-"))
}

describe("provider list body cache (unit)", () => {
  test("memoizes the encoded body: identical inputs encode once and serve byte-identical bodies", async () => {
    const inputs = makeInputs()
    const before = counters()
    const first = await providerListBody(inputs, fullList)
    expect(delta(before).encodes).toBe(1)
    const second = await providerListBody(inputs, fullList)
    expect(delta(before).encodes).toBe(1)
    expect(second).toBe(first)
  })

  test("cached bytes equal the schema encode the framework would produce", async () => {
    const inputs = makeInputs()
    const body = await providerListBody(inputs, fullList)
    const framework = JSON.stringify(
      Schema.encodeUnknownSync(Provider.ListResult)(buildListResult(cloneInputs(inputs), fullList)),
    )
    expect(body).toBe(framework)
  })

  test("disabled_providers excludes connected providers from the connected array", () => {
    const inputs = makeInputs()
    const connectedInfo = structuredClone(inputs.catalog[ProviderV2.ID.make("openai")]!)
    connectedInfo.source = "api"
    const withConnected = {
      ...inputs,
      connected: { [ProviderV2.ID.make("openai")]: connectedInfo },
      config: { disabled_providers: ["openai"] },
    }
    const result = buildListResult(withConnected, fullList)
    expect(result.connected).toEqual([])
    expect(result.all.find((item) => item.id === "openai")).toBeUndefined()
  })

  test("misses when any input identity changes, and re-derives the same bytes for equal content", async () => {
    const base = makeInputs()
    const body = await providerListBody(base, fullList)
    for (const key of ["connected", "catalog", "all", "config"] as const) {
      const swapped = { ...base, [key]: structuredClone(base[key]) }
      const before = counters()
      const rederived = await providerListBody(swapped, fullList)
      expect({ input: key, encodes: delta(before).encodes }).toEqual({ input: key, encodes: 1 })
      expect(rederived).toBe(body === rederived ? body : rederived) // byte-compare below
      expect(rederived).toEqual(body)
    }
  })

  test("distinct query variants are distinct cache entries", async () => {
    const inputs = makeInputs()
    const before = counters()
    const full = await providerListBody(inputs, fullList)
    const index = await providerListBody(inputs, { selectedProvider: null, indexOnly: true })
    const selected = await providerListBody(inputs, { selectedProvider: "anthropic", indexOnly: false })
    expect(delta(before).encodes).toBe(3)
    expect(new Set([full, index, selected]).size).toBe(3)
    await providerListBody(inputs, fullList)
    await providerListBody(inputs, { selectedProvider: null, indexOnly: true })
    await providerListBody(inputs, { selectedProvider: "anthropic", indexOnly: false })
    expect(delta(before).encodes).toBe(3)
  })

  test("persists the zero-connected full-list body and serves it byte-identically to a fresh process", async () => {
    const cacheDir = await tmpCacheDir()
    const options = { cacheDir, version: "9.9.9" }
    const inputs = makeInputs()
    const before = counters()
    const first = await providerListBody(inputs, fullList, options)
    expect(delta(before)).toEqual({ encodes: 1, diskHits: 0, diskWrites: 1 })

    // A fresh process has no memo and all-new object identities.
    const relaunch = cloneInputs(inputs)
    const second = await providerListBody(relaunch, fullList, options)
    expect(delta(before)).toEqual({ encodes: 1, diskHits: 1, diskWrites: 1 })
    expect(second).toBe(first === second ? first : second)
    expect(second).toEqual(first)
  })

  test("disk layer fails closed on changed catalog content, changed config, and changed version", async () => {
    const cacheDir = await tmpCacheDir()
    const inputs = makeInputs()
    await providerListBody(inputs, fullList, { cacheDir, version: "9.9.9" })

    const changedCatalog = cloneInputs(inputs)
    changedCatalog.catalog[ProviderV2.ID.make("anthropic")]!.name = "Renamed"
    let before = counters()
    await providerListBody(changedCatalog, fullList, { cacheDir, version: "9.9.9" })
    expect(delta(before).diskHits).toBe(0)
    expect(delta(before).encodes).toBe(1)

    const changedConfig = cloneInputs(inputs)
    before = counters()
    await providerListBody(
      { ...changedConfig, config: { disabled_providers: ["openai"] } },
      fullList,
      { cacheDir, version: "9.9.9" },
    )
    expect(delta(before).diskHits).toBe(0)
    expect(delta(before).encodes).toBe(1)

    before = counters()
    await providerListBody(cloneInputs(inputs), fullList, { cacheDir, version: "10.0.0" })
    expect(delta(before).diskHits).toBe(0)
    expect(delta(before).encodes).toBe(1)
  })

  test("never persists bodies with connected providers, index views, selected views, or local dev builds", async () => {
    const cacheDir = await tmpCacheDir()
    const inputs = makeInputs()
    const connectedInfo = structuredClone(inputs.catalog[ProviderV2.ID.make("anthropic")]!)
    connectedInfo.source = "env"
    const withConnected = { ...inputs, connected: { [ProviderV2.ID.make("anthropic")]: connectedInfo } }

    const before = counters()
    await providerListBody(withConnected, fullList, { cacheDir, version: "9.9.9" })
    await providerListBody(inputs, { selectedProvider: null, indexOnly: true }, { cacheDir, version: "9.9.9" })
    await providerListBody(inputs, { selectedProvider: "anthropic", indexOnly: false }, { cacheDir, version: "9.9.9" })
    await providerListBody(cloneInputs(inputs), fullList, { cacheDir, version: "local" })
    expect(delta(before).diskWrites).toBe(0)
    expect(delta(before).diskHits).toBe(0)
    expect(await fs.readdir(cacheDir)).toEqual([])
  })

  test("a corrupted disk entry reads as a miss and is repaired by the next derive", async () => {
    const cacheDir = await tmpCacheDir()
    const inputs = makeInputs()
    const first = await providerListBody(inputs, fullList, { cacheDir, version: "9.9.9" })
    await fs.writeFile(path.join(cacheDir, "provider-list.v1.json"), "corrupted")

    const before = counters()
    const second = await providerListBody(cloneInputs(inputs), fullList, { cacheDir, version: "9.9.9" })
    expect(delta(before)).toEqual({ encodes: 1, diskHits: 0, diskWrites: 1 })
    expect(second).toEqual(first)

    const third = await providerListBody(cloneInputs(inputs), fullList, { cacheDir, version: "9.9.9" })
    expect(delta(before).diskHits).toBe(1)
    expect(third).toEqual(first)
  })

  test("concurrent writers always publish a matching key and body", async () => {
    const cacheDir = await tmpCacheDir()
    const options = { cacheDir, version: "9.9.9" }
    const anthropicOnly = makeInputs({ config: { disabled_providers: ["openai"] } })
    const openaiOnly = makeInputs({ config: { disabled_providers: ["anthropic"] } })

    const [anthropicBody, openaiBody] = await Promise.all([
      providerListBody(anthropicOnly, fullList, options),
      providerListBody(openaiOnly, fullList, options),
    ])

    const entry = JSON.parse(await fs.readFile(path.join(cacheDir, "provider-list.v1.json"), "utf8")) as {
      key: string
      body: string
    }
    expect(entry.body === anthropicBody || entry.body === openaiBody).toBe(true)

    const matchingInputs = entry.body === anthropicBody ? cloneInputs(anthropicOnly) : cloneInputs(openaiOnly)
    const before = counters()
    expect(await providerListBody(matchingInputs, fullList, options)).toBe(entry.body)
    expect(delta(before)).toEqual({ encodes: 0, diskHits: 1, diskWrites: 0 })
  })
})

const testStateLayer = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.promise(() => resetDatabase()),
    () => Effect.promise(() => resetDatabase()),
  ),
)

const it = testEffect(Layer.mergeAll(testStateLayer, httpApiLayer))
const projectOptions = { config: { formatter: false, lsp: false } }

function setEnvScoped(key: string, value: string) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env[key]
      process.env[key] = value
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[key]
        else process.env[key] = previous
      }),
  )
}

describe("GET /provider body cache (route)", () => {
  it.instance(
    "serves repeat identical requests from cache: one encode, byte-identical bodies",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const headers = { "x-opencode-directory": directory }

      const before = counters()
      const first = yield* request("/provider", { headers })
      expect(first.status).toBe(200)
      const firstBody = yield* first.text
      expect(delta(before).encodes).toBe(1)

      const second = yield* request("/provider", { headers })
      expect(second.status).toBe(200)
      const secondBody = yield* second.text
      expect(delta(before).encodes).toBe(1)
      expect(secondBody).toBe(firstBody)

      // Distinct query → distinct entry, not the full-list bytes.
      const index = yield* request("/provider?view=index", { headers })
      expect(index.status).toBe(200)
      const indexBody = yield* index.text
      expect(delta(before).encodes).toBe(2)
      expect(indexBody).not.toBe(firstBody)
    }),
    projectOptions,
    30000,
  )

  it.instance(
    "an auth change made visible by instance disposal is not served from the cache",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const headers = { "x-opencode-directory": directory }

      const first = yield* request("/provider", { headers })
      expect(first.status).toBe(200)
      const firstBody = yield* first.text
      const firstParsed = JSON.parse(firstBody) as { connected: string[] }
      expect(firstParsed.connected).not.toContain("google")

      yield* setEnvScoped(
        "OPENCODE_AUTH_CONTENT",
        JSON.stringify({
          google: { type: "api", key: "test-google-key" },
        }),
      )
      // The same InstanceStore reload that markInstanceForReload/disposeMiddleware
      // perform in production; the shared test harness serves HttpApiApp.routes
      // without disposeMiddleware, so /instance/dispose cannot tear down here.
      yield* reloadInstance({ directory })

      const before = counters()
      const second = yield* request("/provider", { headers })
      expect(second.status).toBe(200)
      const secondBody = yield* second.text
      expect(delta(before).encodes).toBe(1)
      const secondParsed = JSON.parse(secondBody) as { connected: string[] }
      expect(secondParsed.connected).toContain("google")
      expect(secondBody).not.toBe(firstBody)
    }),
    projectOptions,
    30000,
  )
})
