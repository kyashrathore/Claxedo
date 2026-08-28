import { describe, expect, test } from "vitest"
import { HostedWorkerCompositionError, lifecycleMinutes, sandboxDriver } from "./hosted-services"

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

  test("composes the Worker-safe exe.dev driver with bearer auth and same-VM persistence", async () => {
    const calls: Array<{ authorization: string | null; command: string }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url, init) => {
      calls.push({
        authorization: new Headers(init?.headers).get("authorization"),
        command: String(init?.body ?? ""),
      })
      return Response.json({ vms: [] })
    }) as typeof fetch
    try {
      const driver = sandboxDriver({
        CLAXEDO_SANDBOX_DRIVER: "exe",
        EXE_DEV_API_TOKEN: "exe-token",
      })
      expect(driver?.id).toBe("exe")
      expect(driver?.metadata.driverRunsIn).toEqual(["worker", "node"])
      expect(driver?.metadata.persistence).toMatchObject({ resume: "same-sandbox", clone: true })
      await driver?.list?.()
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(calls).toEqual([{
      authorization: "Bearer exe-token",
      command: "ls claxedo-ws-*",
    }])
  })

  test("composes Cloudflare with a dedicated sandbox bearer independent of deployment credentials", () => {
    const driver = sandboxDriver({
      CLAXEDO_SANDBOX_DRIVER: "cloudflare",
      CLOUDFLARE_SANDBOX_WORKER_URL: "https://sbx.example.com",
      CLOUDFLARE_SANDBOX_API_TOKEN: "sandbox-secret",
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

  test("does not select a native driver from credentials", () => {
    expect(sandboxDriver({
      CLOUDFLARE_SANDBOX_WORKER_URL: "https://sbx.example.com",
      CLOUDFLARE_SANDBOX_API_TOKEN: "secret",
    })).toBeUndefined()
    expect(sandboxDriver({
      DAYTONA_API_KEY: "dtn-key",
      CLAXEDO_DAYTONA_SNAPSHOT: "claxedo/runtime:latest",
    })).toBeUndefined()
    expect(sandboxDriver({ EXE_DEV_API_TOKEN: "exe-token" })).toBeUndefined()
  })

  test("explicit driver selection is authoritative when other provider credentials are present", () => {
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

  test("sandbox lifecycle env converts ms to whole minutes and never floors to zero", () => {
    // Defaults, in the ms the env contract speaks: 30 min stop, 24 h delete.
    expect(lifecycleMinutes({}, "CLAXEDO_SANDBOX_AUTO_STOP_MS", 30 * 60_000)).toBe(30)
    expect(lifecycleMinutes({}, "CLAXEDO_SANDBOX_AUTO_DELETE_MS", 24 * 60 * 60_000)).toBe(1440)

    expect(lifecycleMinutes(
      { CLAXEDO_SANDBOX_AUTO_STOP_MS: String(45 * 60_000) },
      "CLAXEDO_SANDBOX_AUTO_STOP_MS",
      30 * 60_000,
    )).toBe(45)

    // The guard that matters: Daytona reads BOTH intervals as "0 means
    // immediately" — autoStop 0 disables idle stop entirely, and autoDelete 0
    // marks the sandbox ephemeral, destroying its filesystem on first stop. A
    // sub-minute env value is always a misconfiguration and must clamp to 1,
    // never round down to that cliff.
    for (const ms of ["1", "1000", "29999"]) {
      expect(lifecycleMinutes(
        { CLAXEDO_SANDBOX_AUTO_DELETE_MS: ms },
        "CLAXEDO_SANDBOX_AUTO_DELETE_MS",
        24 * 60 * 60_000,
      )).toBe(1)
    }

    // Non-positive values stay a composition error rather than a silent clamp.
    expect(() => lifecycleMinutes(
      { CLAXEDO_SANDBOX_AUTO_STOP_MS: "0" },
      "CLAXEDO_SANDBOX_AUTO_STOP_MS",
      30 * 60_000,
    )).toThrow(HostedWorkerCompositionError)
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
      ).toThrow("exe, cloudflare, daytona, or fetch")
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
