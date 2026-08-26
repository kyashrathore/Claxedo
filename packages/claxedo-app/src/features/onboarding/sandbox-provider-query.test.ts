import { beforeAll, describe, expect, test } from "vitest"
import { configureAppPortsForTest } from "@/app/integrations/test-support/app-ports-stub"
import { readSandboxProviderStatus } from "./sandbox-provider-query"

// The driver URL is an injected port; without it the module throws before the
// reader is ever called.
beforeAll(() => configureAppPortsForTest())

function driver(overrides: Record<string, unknown> = {}) {
  return { id: "daytona", label: "Daytona", configured: true, default: true, ...overrides }
}

const reading = (body: Record<string, unknown>) => ({ read: async () => body })

describe("sandbox provider status", () => {
  test("reports configured when the default driver carries credentials", async () => {
    const status = await readSandboxProviderStatus(reading({ default_driver: "daytona", drivers: [driver()] }))
    expect(status).toEqual({ configured: true, providerId: "daytona", providerLabel: "Daytona" })
  })

  test("a default driver without credentials is not configured", async () => {
    // The server rejects workspace creation in exactly this state, so setup must
    // not offer the compute step.
    const status = await readSandboxProviderStatus(
      reading({ default_driver: "daytona", drivers: [driver({ configured: false })] }),
    )
    expect(status).toEqual({ configured: false })
  })

  test("a configured non-default driver still means the cloud works", async () => {
    // The default is a suggestion, not a claim about what works here. Ambient
    // MODAL_*/CLOUDFLARE_* env vars configure those drivers while `daytona`
    // stays default — reading only the default reported "no cloud" on a machine
    // with two working providers, and stranded setup on a satisfied step.
    const status = await readSandboxProviderStatus(
      reading({
        default_driver: "daytona",
        drivers: [
          driver({ configured: false }),
          driver({ id: "modal", label: "Modal", configured: true, default: false }),
        ],
      }),
    )
    expect(status).toEqual({ configured: true, providerId: "modal", providerLabel: "Modal" })
  })

  test("the default wins when it is one of the configured ones", async () => {
    const status = await readSandboxProviderStatus(
      reading({
        default_driver: "daytona",
        drivers: [driver(), driver({ id: "modal", label: "Modal", default: false })],
      }),
    )
    expect(status).toEqual({ configured: true, providerId: "daytona", providerLabel: "Daytona" })
  })

  test("no configured driver anywhere is still not configured", async () => {
    const status = await readSandboxProviderStatus(
      reading({
        default_driver: "daytona",
        drivers: [driver({ configured: false }), driver({ id: "modal", configured: false, default: false })],
      }),
    )
    expect(status).toEqual({ configured: false })
  })

  test("falls back to the driver flagged default when the field is absent", async () => {
    const status = await readSandboxProviderStatus(reading({ drivers: [driver({ id: "e2b", label: "E2B" })] }))
    expect(status).toEqual({ configured: true, providerId: "e2b", providerLabel: "E2B" })
  })

  test("an empty catalog is not configured", async () => {
    expect(await readSandboxProviderStatus(reading({ drivers: [] }))).toEqual({ configured: false })
  })

  test("a malformed payload is not configured rather than a crash", async () => {
    const status = await readSandboxProviderStatus(reading({ drivers: [null, { label: "no id" }] }))
    expect(status).toEqual({ configured: false })
  })
})
