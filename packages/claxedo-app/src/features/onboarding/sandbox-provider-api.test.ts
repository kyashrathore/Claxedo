import { beforeAll, describe, expect, test } from "vitest"
import { configureAppPortsForTest } from "@/app/integrations/test-support/app-ports-stub"
import {
  canSaveSandboxProvider,
  parseCatalog,
  parseVerification,
  readSandboxProviderCatalog,
  sandboxProviderFailureCopy,
  saveSandboxProviderKey,
  type SandboxProviderOption,
} from "./sandbox-provider-api"

// The driver URL is an injected port; without it the module throws before the
// reader is ever called.
beforeAll(() => configureAppPortsForTest())

const driver = (overrides: Record<string, unknown> = {}) => ({
  id: "daytona",
  label: "Daytona",
  fields: [{ key: "apiKey", label: "API key", secret: true }],
  configured: false,
  default: true,
  ...overrides,
})

const authUrl = (input: { driverId: string }) => `https://server/api/workspace/drivers/${input.driverId}/auth`

describe("the sandbox provider catalog", () => {
  test("carries the fields the key form has to render", async () => {
    const catalog = await readSandboxProviderCatalog({
      read: async () => ({ default_driver: "daytona", drivers: [driver()] }),
    })

    expect(catalog.defaultProviderId).toBe("daytona")
    expect(catalog.providers).toEqual([{
      id: "daytona",
      label: "Daytona",
      fields: [{ key: "apiKey", label: "API key", secret: true }],
      configured: false,
      isDefault: true,
    }])
  })

  test("an unconfigured provider is still listed — that is the whole point of the step", () => {
    // The circularity fix: the step exists precisely for a provider with no key.
    const catalog = parseCatalog({ default_driver: "daytona", drivers: [driver({ configured: false })] })
    expect(catalog.providers).toHaveLength(1)
    expect(catalog.providers[0]!.configured).toBe(false)
  })

  test("falls back to the driver flagged default when the field is absent", () => {
    const catalog = parseCatalog({ drivers: [driver({ id: "e2b", label: "E2B" })] })
    expect(catalog.providers[0]!.isDefault).toBe(true)
    expect(catalog.defaultProviderId).toBeUndefined()
  })

  test("a malformed payload yields no providers rather than a crash", () => {
    expect(parseCatalog({ drivers: [null, { label: "no id" }] }).providers).toEqual([])
    expect(parseCatalog({}).providers).toEqual([])
  })

  test("malformed fields are dropped, not rendered as blank inputs", () => {
    const catalog = parseCatalog({ drivers: [driver({ fields: [{ label: "no key" }, { key: "token" }] })] })
    expect(catalog.providers[0]!.fields).toEqual([{ key: "token", label: "token", secret: false }])
  })
})

describe("saving a provider key", () => {
  test("sends the values and makes that provider the default in one call", async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const outcome = await saveSandboxProviderKey({
      providerId: "daytona",
      values: { apiKey: "dtn_live_123" },
      authUrl,
      write: async (url, body) => {
        calls.push({ url, body })
        return { default_driver: "daytona", drivers: [driver({ configured: true })] }
      },
    })

    // Saving a key for the provider you just picked is also how you choose it.
    expect(calls).toEqual([{
      url: "https://server/api/workspace/drivers/daytona/auth",
      body: { auth: { apiKey: "dtn_live_123" }, default: true },
    }])
    expect(outcome.ok && outcome.catalog.providers[0]!.configured).toBe(true)
  })

  test("a rejection comes back as a sentence, never as a server code", async () => {
    const outcome = await saveSandboxProviderKey({
      providerId: "daytona",
      values: { apiKey: "bad" },
      authUrl,
      write: async () => {
        throw new Error("sandbox_driver_credentials_missing: Missing daytona credentials")
      },
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.reason).toBe(
      "That provider still has no working key. Check the value and save it again.",
    )
    expect(outcome.ok === false && outcome.reason).not.toContain("sandbox_driver")
  })
})

describe("failure copy", () => {
  test.each([
    ["sandbox_driver_credentials_missing", "no working key"],
    ["sandbox_driver_unsupported", "doesn't offer that sandbox provider"],
    ["Request failed: 401", "rejected that key"],
    ["Request failed: 404", "can't manage sandbox provider keys"],
    ["socket hang up", "Couldn't save that key"],
  ])("%s maps to a repair the user can act on", (message, expected) => {
    const copy = sandboxProviderFailureCopy(new Error(message))
    expect(copy).toContain(expected)
    expect(copy).not.toMatch(/sandbox_driver_|^Request failed/)
  })
})

describe("the provider's verdict", () => {
  test("rides along on catalog rows", () => {
    const catalog = parseCatalog({
      default_driver: "daytona",
      drivers: [driver({ verification: { state: "working" } })],
    })
    expect(catalog.providers[0]!.verification).toEqual({ state: "working" })
  })

  test("an unknown verdict keeps the server's sentence to render verbatim", () => {
    const catalog = parseCatalog({
      drivers: [driver({
        id: "modal",
        default: true,
        verification: { state: "unknown", reason: "Claxedo can't check this provider yet — the key was saved as-is." },
      })],
    })
    expect(catalog.providers[0]!.verification).toEqual({
      state: "unknown",
      reason: "Claxedo can't check this provider yet — the key was saved as-is.",
    })
  })

  test("a row from a server without verdicts has none, which is not the same as unknown", () => {
    // Absent means "this server never said"; unknown means "it tried and
    // couldn't". Inventing the latter would put copy on screen nobody wrote.
    expect(parseCatalog({ drivers: [driver()] }).providers[0]!.verification).toBeUndefined()
    expect(parseVerification(undefined)).toBeUndefined()
    expect(parseVerification({ state: "made_up" })).toBeUndefined()
  })

  test("the save carries the verdict back so the screen can spend a tick honestly", async () => {
    const outcome = await saveSandboxProviderKey({
      providerId: "daytona",
      values: { apiKey: "k" },
      authUrl,
      write: async () => ({
        default_driver: "daytona",
        drivers: [driver({ configured: true })],
        verification: { state: "working" },
      }),
    })
    expect(outcome.ok && outcome.verification).toEqual({ state: "working" })
  })

  test("a rejection prefers the server's reason over anything re-derived here", async () => {
    // The server knows whether the key was malformed, unauthorized, or merely
    // unbilled; matching on the message text would answer more vaguely.
    const outcome = await saveSandboxProviderKey({
      providerId: "daytona",
      values: { apiKey: "bad" },
      authUrl,
      write: async () => {
        throw new Error(JSON.stringify({
          error: {
            code: "sandbox_driver_key_rejected",
            message: "Sandbox provider rejected the key",
            reason: "That key works, but the provider reports no active billing on the account. Add billing, then save it again.",
          },
        }))
      },
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.reason).toContain("no active billing")
    expect(outcome.ok === false && outcome.reason).not.toContain("sandbox_driver_key_rejected")
  })

  test("a rejection with no structured reason still falls back to a repair", async () => {
    const outcome = await saveSandboxProviderKey({
      providerId: "daytona",
      values: { apiKey: "bad" },
      authUrl,
      write: async () => {
        throw new Error("Request failed: 401")
      },
    })
    expect(outcome.ok === false && outcome.reason).toContain("copied whole")
  })
})

describe("the save gate", () => {
  const provider: SandboxProviderOption = {
    id: "daytona",
    label: "Daytona",
    fields: [{ key: "apiKey", label: "API key", secret: true }, { key: "org", label: "Org", secret: false }],
    configured: false,
    isDefault: true,
  }

  test("every field must be filled — a partial set stores nothing and reports success", () => {
    expect(canSaveSandboxProvider(provider, { apiKey: "k" })).toBe(false)
    expect(canSaveSandboxProvider(provider, { apiKey: "k", org: "  " })).toBe(false)
    expect(canSaveSandboxProvider(provider, { apiKey: "k", org: "acme" })).toBe(true)
  })

  test("a provider with no fields cannot be saved", () => {
    expect(canSaveSandboxProvider({ ...provider, fields: [] }, {})).toBe(false)
  })
})
