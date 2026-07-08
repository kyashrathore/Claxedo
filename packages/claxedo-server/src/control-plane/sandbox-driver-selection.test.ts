import { describe, expect, test } from "vitest"
import { HostedWorkerCompositionError, sandboxDriver } from "./hosted-services"

describe("sandbox driver selection", () => {
  test("composes the native Cloudflare driver when CLAXEDO_SANDBOX_DRIVER=cloudflare and CF env is set", () => {
    const driver = sandboxDriver({
      CLAXEDO_SANDBOX_DRIVER: "cloudflare",
      CLOUDFLARE_SANDBOX_WORKER_URL: "https://sbx.example.com",
      CLOUDFLARE_API_TOKEN: "secret",
      CLAXEDO_RELAY_JWKS_URL: "https://relay.test/jwks.json",
    })
    expect(driver?.id).toBe("cloudflare")
  })

  test("Cloudflare selection without worker url/token yields no driver (fail-soft)", () => {
    expect(sandboxDriver({ CLAXEDO_SANDBOX_DRIVER: "cloudflare" })).toBeUndefined()
    expect(
      sandboxDriver({ CLAXEDO_SANDBOX_DRIVER: "cloudflare", CLOUDFLARE_SANDBOX_WORKER_URL: "https://x" }),
    ).toBeUndefined()
  })

  test("default selection does not treat the fetch bridge URL as a hosted driver", () => {
    expect(sandboxDriver({})).toBeUndefined()
    expect(sandboxDriver({ CLAXEDO_SANDBOX_DRIVER_URL: "https://driver.test" })).toBeUndefined()
  })

  test("default selection auto-picks native Worker-safe drivers from their own credentials", () => {
    expect(sandboxDriver({
      CLOUDFLARE_SANDBOX_WORKER_URL: "https://sbx.example.com",
      CLOUDFLARE_API_TOKEN: "secret",
    })?.id).toBe("cloudflare")
    expect(sandboxDriver({
      DAYTONA_API_KEY: "dtn-key",
      CLAXEDO_DAYTONA_SNAPSHOT: "claxedo/runtime:latest",
    })?.id).toBe("daytona")
  })

  test("explicit driver selection wins over native auto-detection", () => {
    expect(sandboxDriver({
      CLAXEDO_SANDBOX_DRIVER: "daytona",
      CLOUDFLARE_SANDBOX_WORKER_URL: "https://sbx.example.com",
      CLOUDFLARE_API_TOKEN: "secret",
      DAYTONA_API_KEY: "dtn-key",
      CLAXEDO_DAYTONA_SNAPSHOT: "claxedo/runtime:latest",
    })?.id).toBe("daytona")
  })

  test("explicit fetch selection composes only the bridge driver", () => {
    const driver = sandboxDriver({
      CLAXEDO_SANDBOX_DRIVER: "fetch",
      CLAXEDO_SANDBOX_DRIVER_URL: "https://driver.test",
    })
    expect(driver?.id).toBe("fetch")
  })

  test("ignores legacy runtime-driver aliases because sandbox config is only CLAXEDO_SANDBOX_*", () => {
    expect(sandboxDriver({
      CLAXEDO_RUNTIME_DRIVER: "fetch",
      CLAXEDO_RUNTIME_DRIVER_URL: "https://driver.test",
    })).toBeUndefined()
    expect(sandboxDriver({
      CLAXEDO_SANDBOX_DRIVER: "fetch",
      CLAXEDO_RUNTIME_DRIVER_URL: "https://driver.test",
    })).toBeUndefined()
    expect(sandboxDriver({
      CLAXEDO_SANDBOX_DRIVER: "fetch",
      CLAXEDO_SANDBOX_DRIVER_URL: "https://driver.test",
    })?.id).toBe("fetch")
  })

  test("composes the native Daytona SDK sandbox driver when its env is set", () => {
    const driver = sandboxDriver({
      CLAXEDO_SANDBOX_DRIVER: "daytona",
      DAYTONA_API_KEY: "dtn-key",
      CLAXEDO_DAYTONA_SNAPSHOT: "claxedo/runtime:latest",
      CLAXEDO_RELAY_JWKS_URL: "https://relay.test/jwks.json",
    })
    expect(driver?.id).toBe("daytona")
    expect(driver?.metadata.driverRunsIn).toEqual(["worker", "node"])
    expect(driver?.metadata.hostStopBehavior).toBe("suspends-host")
    expect(driver?.metadata.hostResumeBehavior).toBe("same-host")
  })

  test("Daytona selection without key/snapshot yields no driver (fail-soft)", () => {
    expect(sandboxDriver({ CLAXEDO_SANDBOX_DRIVER: "daytona" })).toBeUndefined()
    expect(sandboxDriver({ CLAXEDO_SANDBOX_DRIVER: "daytona", DAYTONA_API_KEY: "k" })).toBeUndefined()
  })

  test("hosted Worker rejects Node-only drivers instead of treating them as fetch bridge ids", () => {
    for (const driver of ["modal", "vercel", "docker"]) {
      expect(() =>
        sandboxDriver({
          CLAXEDO_SANDBOX_DRIVER: driver,
          CLAXEDO_SANDBOX_DRIVER_URL: "https://driver.test",
        }),
      ).toThrow(HostedWorkerCompositionError)
      expect(() =>
        sandboxDriver({
          CLAXEDO_SANDBOX_DRIVER: driver,
          CLAXEDO_SANDBOX_DRIVER_URL: "https://driver.test",
        }),
      ).toThrow("cloudflare, daytona, or fetch")
    }
  })

  test("legacy CLAXEDO_RUNTIME_PROVIDER aliases are ignored", () => {
    expect(sandboxDriver({
      CLAXEDO_RUNTIME_PROVIDER: "fetch",
      CLAXEDO_RUNTIME_PROVIDER_URL: "https://legacy-driver.test",
    })).toBeUndefined()
    expect(sandboxDriver({
      CLAXEDO_SANDBOX_DRIVER: "daytona",
      CLAXEDO_RUNTIME_PROVIDER: "fetch",
      CLAXEDO_RUNTIME_PROVIDER_URL: "https://legacy-driver.test",
      DAYTONA_API_KEY: "dtn-key",
      CLAXEDO_DAYTONA_SNAPSHOT: "claxedo/runtime:latest",
      CLAXEDO_RELAY_JWKS_URL: "https://relay.test/jwks.json",
    })?.id).toBe("daytona")
  })

  test("uses WORKSPACE_RUNTIME_PORT and ignores the old double-runtime port alias", async () => {
    expect(() =>
      sandboxDriver({
        CLAXEDO_SANDBOX_DRIVER: "cloudflare",
        CLOUDFLARE_SANDBOX_WORKER_URL: "https://sbx.example.com",
        CLOUDFLARE_API_TOKEN: "secret",
        WORKSPACE_RUNTIME_PORT: "bad",
      }),
    ).toThrow("WORKSPACE_RUNTIME_PORT must be a positive integer")

    const calls: Array<{ body: unknown }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url, init) => {
      calls.push({ body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return new Response(JSON.stringify({
        sandboxId: "sandbox_1",
        url: "https://runtime.test",
        hostId: "host_1",
      }))
    }) as typeof fetch
    try {
      const driver = sandboxDriver({
        CLAXEDO_SANDBOX_DRIVER: "cloudflare",
        CLOUDFLARE_SANDBOX_WORKER_URL: "https://sbx.example.com",
        CLOUDFLARE_API_TOKEN: "secret",
        CLAXEDO_RUNTIME_RUNTIME_PORT: "bad",
      })
      await driver?.ensureHost({
        workspaceId: "ws_1",
        homeRegion: "us-east",
        epoch: 1,
        labels: {},
      })
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(calls[0]?.body).toMatchObject({ port: 2593 })
  })
})
