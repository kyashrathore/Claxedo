/**
 * The harness → provider-catalog contract, asserted against the real
 * `/provider` route for EVERY harness id the app can select.
 *
 * `opencode-compat-provider-harness.test.ts` next door covers route plumbing
 * (resolve-before-compare, engine overlay, deferral). This file covers CONTENT:
 * which provider ids each harness's catalog actually contains. Several UI bugs
 * shipped because nothing pinned that — a session's connect dialog served pi's
 * three providers to a non-pi session and no test noticed.
 *
 * The engine fetch is stubbed, so the "full catalog" case is exercised without
 * a live models.dev.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest"
import { mkdirSync, realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import {
  DEFAULT_HARNESS_ID,
  HARNESS_BINDING_PROVIDER_IDS,
  HARNESS_IDS,
  HARNESS_PROVIDER_CONTRACT,
  OPENCODE_REQUIRED_PROVIDER_IDS,
  PI_PROVIDER_IDS,
} from "./harness-provider-contract"

const root = path.join(realpathSync(os.tmpdir()), `harness-provider-contract-${randomUUID().slice(0, 8)}`)
const previous = {
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
  CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR,
}
process.env.CLAXEDO_DATA_DIR = root
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")
// The pi catalog reads the credential registry out of the claxedo DB, which
// cannot open into a directory that does not exist yet (the route answers 502
// `provider_models_unavailable` if it is missing).
mkdirSync(process.env.CLAXEDO_STATE_DIR, { recursive: true })

const { Hono } = await import("hono")
const { OpenCodeCompatRoutes } = await import("@claxedo/local-server/opencode/compat-routes/index")
const { configureOpenCodeEngine } = await import("@claxedo/server-core/opencode/engine")
const { configureAgentConfig } = await import("@claxedo/server-core/agent-config/index")
const { ClaxedoDB } = await import("@claxedo/server-core/platform/db/db")

const ENGINE = "http://127.0.0.1:65501"

/**
 * A models.dev-shaped catalog: big, and carrying the provider ids the contract
 * requires. Padded past the minimum count so the "much larger than the harness
 * list" invariant is exercised rather than trivially satisfied.
 */
const ENGINE_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "opencode",
  "github-copilot",
  "openrouter",
  ...Array.from({ length: 80 }, (_, i) => `models-dev-provider-${i}`),
]
const ENGINE_PROVIDER_CATALOG = {
  all: ENGINE_PROVIDERS.map((id) => ({
    id,
    name: id,
    models: { [`${id}-model`]: { id: `${id}-model`, name: `${id} model` } },
  })),
  connected: ["anthropic"],
  default: { anthropic: "anthropic-model" },
}

const app = new Hono()
app.route("/", OpenCodeCompatRoutes())

const originalFetch = globalThis.fetch

beforeEach(() => {
  configureOpenCodeEngine({ url: ENGINE })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    if (url.pathname === "/provider") return Response.json(ENGINE_PROVIDER_CATALOG)
    return new Response("not found", { status: 404 })
  }) as typeof globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  configureOpenCodeEngine({ url: "http://127.0.0.1:4096" })
})

afterAll(async () => {
  // Close-then-retry for Windows: an open claxedo.db makes the rm EBUSY, and
  // the file stays briefly locked even after close.
  configureAgentConfig()
  ClaxedoDB.close()
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

async function providerIds(query: string) {
  const res = await app.request(`/provider${query}`)
  expect(res.status, query).toBe(200)
  const body = (await res.json()) as { all: Array<{ id: string }> }
  return body.all.map((provider) => provider.id)
}

describe("harness → provider catalog contract", () => {
  // One case per harness id, generated from the canonical list, so a harness
  // added to `HARNESS_IDS` without a contract entry fails to compile and a
  // harness whose catalog silently changes fails here.
  for (const harness of HARNESS_IDS) {
    const contract = HARNESS_PROVIDER_CONTRACT[harness]

    test(`?harness=${harness} serves its contracted provider set`, async () => {
      const ids = await providerIds(`?harness=${harness}`)

      if (contract.kind === "exact") {
        expect(ids.slice().sort()).toEqual([...contract.providerIds].sort())
        return
      }

      expect(ids.length).toBeGreaterThan(contract.minProviderCount)
      for (const required of contract.requiredProviderIds) expect(ids, required).toContain(required)
      // The harness-binding ids live in a different namespace; their presence
      // means the local fallback catalog was served in place of the real one.
      for (const forbidden of contract.forbiddenProviderIds) expect(ids, forbidden).not.toContain(forbidden)
    })
  }

  test("an absent ?harness= resolves to the default harness's catalog", async () => {
    const unqualified = await providerIds("")
    const explicit = await providerIds(`?harness=${DEFAULT_HARNESS_ID}`)
    expect(unqualified).toEqual(explicit)
  })

  test("the legacy ?runner= alias reaches the same catalog as ?harness=", async () => {
    expect(await providerIds("?runner=pi")).toEqual(await providerIds("?harness=pi"))
    expect(await providerIds("?runner=claude-sdk")).toEqual(await providerIds("?harness=claude-sdk"))
  })

  // The three catalogs are genuinely different sets, not accidental overlaps —
  // this is the invariant the UI depends on when it routes a connect dialog by
  // harness, and the one the pi-catalog-in-an-opencode-session bug violated.
  test("the pi, harness-binding, and opencode catalogs are mutually distinct", async () => {
    const pi = new Set(await providerIds("?harness=pi"))
    const binding = new Set(await providerIds("?harness=claude-sdk"))
    const opencode = new Set(await providerIds("?harness=opencode"))

    expect([...pi].some((id) => binding.has(id))).toBe(false)
    expect([...binding].some((id) => opencode.has(id))).toBe(false)
    expect(pi.size).toBe(PI_PROVIDER_IDS.length)
  })

  // Degrading to the five harness bindings would put `claude-acp` in a picker
  // that is supposed to list models.dev providers.
  test("an unreachable engine degrades opencode to an EMPTY catalog, never the harness bindings", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 503 })) as unknown as typeof globalThis.fetch
    expect(await providerIds("?harness=opencode")).toEqual([])
  })

  /**
   * The app has a hand-written mirror of these sets (it cannot import across
   * package boundaries). A mirror that silently drifts is worse than no mirror:
   * the UI tests would keep passing against a catalog the server stopped
   * serving. Compare the literal arrays rather than trusting a comment.
   */
  test("the app's mirrored contract lists the same provider ids", async () => {
    const mirrorPath = path.resolve(
      import.meta.dirname,
      "../../../claxedo-app/src/app/dialogs/test-support/harness-provider-contract.ts",
    )
    const source = await fs.readFile(mirrorPath, "utf8")
    const ids = (name: string) => {
      const match = source.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`))
      if (!match) throw new Error(`app mirror is missing ${name}`)
      return [...match[1]!.matchAll(/"([^"]+)"/g)].map((entry) => entry[1]!).sort()
    }

    expect(ids("HARNESS_BINDING_PROVIDER_IDS")).toEqual([...HARNESS_BINDING_PROVIDER_IDS].sort())
    expect(ids("PI_PROVIDER_IDS")).toEqual([...PI_PROVIDER_IDS].sort())
    expect(ids("OPENCODE_SAMPLE_PROVIDER_IDS")).toEqual([...OPENCODE_REQUIRED_PROVIDER_IDS].sort())
    // The app's list of harnesses that map to the bindings is every selectable
    // harness except the two with catalogs of their own.
    expect(ids("HARNESS_BINDING_HARNESS_IDS")).toEqual(
      HARNESS_IDS.filter((id) => id !== "pi" && id !== "opencode")
        .slice()
        .sort(),
    )
  })

  // The catalog carries usable models, not bare ids: a picker rendered from an
  // all-empty-models catalog shows provider groups with nothing to select.
  test("the pi catalog ships models for every provider it lists", async () => {
    const res = await app.request("/provider?harness=pi")
    const body = (await res.json()) as { all: Array<{ id: string; models: Record<string, unknown> }> }
    expect(body.all.length).toBe(PI_PROVIDER_IDS.length)
    for (const provider of body.all) {
      expect(Object.keys(provider.models).length, provider.id).toBeGreaterThan(0)
    }
  })
})
