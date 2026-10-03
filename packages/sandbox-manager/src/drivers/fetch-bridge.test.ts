import { describe, expect, test, vi } from "vitest"
import { createFetchBridgeSandboxDriver } from "./fetch-bridge"

describe("fetch sandbox driver", () => {
  test("carries the acquired host and runtime environment through the server-to-server ensure request", async () => {
    const fetch = vi.fn(async (_url: unknown, _init: RequestInit) => Response.json({ sandboxId: "sandbox_1", url: "https://runtime.test/ws_1", hostId: "host_1" }))
    const env = vi.fn(async () => ({ WORKSPACE_RUNTIME_SESSION_ROWS_TOKEN: "producer-pass" }))
    const driver = createFetchBridgeSandboxDriver({ id: "http-test", baseUrl: "https://driver.test", fetch: fetch as typeof globalThis.fetch,
      autoStopMs: 600_000, autoDeleteMs: 86_400_000, env })
    const input = { workspaceId: "ws_1", hostId: "host_1", homeRegion: "us-east" as const, epoch: 7, labels: {}, env: { WORKSPACE_RUNTIME_OWNER_GRANT: "owner-pass" } }
    await driver.ensureHost(input)
    expect(env).toHaveBeenCalledWith(input, { id: "host_1" })
    const request = JSON.parse(fetch.mock.calls[0][1].body as string)
    expect(request).toMatchObject({ hostId: "host_1", epoch: 7, env: { WORKSPACE_RUNTIME_SESSION_ROWS_TOKEN: "producer-pass", WORKSPACE_RUNTIME_OWNER_GRANT: "owner-pass" } })
    fetch.mockResolvedValueOnce(Response.json({ sandboxId: "sandbox_2", url: "https://runtime.test/ws_1", hostId: "different-host" }))
    await expect(driver.ensureHost(input)).rejects.toThrow("different from its authorized runtime environment")
    await expect(driver.ensureHost({ ...input, env: { WORKSPACE_RUNTIME_HOST_ID: "forged-host" } })).rejects.toThrow("runtime identity")
  })
  test("sends sandbox-control settings and labels on every ensureHost", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            sandboxId: "sandbox_1",
            url: "https://runtime.test/ws_1",
            hostId: "host_1",
            labels: { app: "claxedo", workspaceId: "ws_1", epoch: "7" },
          }),
        ),
    )
    const driver = createFetchBridgeSandboxDriver({
      id: "http-test",
      baseUrl: "https://driver.test/",
      token: "secret",
      fetch: fetch as never,
      autoStopMs: 600_000,
      autoDeleteMs: 86_400_000,
    })

    await expect(
      driver.ensureHost({
        workspaceId: "ws_1",
        homeRegion: "us-east",
        epoch: 7,
        labels: { app: "claxedo", workspaceId: "ws_1", epoch: "7" },
      }),
    ).resolves.toMatchObject({
      sandboxId: "sandbox_1",
      url: "https://runtime.test/ws_1",
      hostId: "host_1",
    })
    expect(fetch).toHaveBeenCalledWith(
      "https://driver.test/runtime/ensure",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer secret" }),
        body: JSON.stringify({
          workspaceId: "ws_1",
          homeRegion: "us-east",
          epoch: 7,
          labels: { app: "claxedo", workspaceId: "ws_1", epoch: "7" },
          hostControl: { autoStopMs: 600_000, autoDeleteMs: 86_400_000 },
        }),
      }),
    )
  })

  test("refuses bridge driver config without finite sandbox-control policies", () => {
    expect(() =>
      createFetchBridgeSandboxDriver({
        id: "bad",
        baseUrl: "https://driver.test",
        autoStopMs: 0,
        autoDeleteMs: 86_400_000,
      }),
    ).toThrow("auto-stop")
    expect(() =>
      createFetchBridgeSandboxDriver({
        id: "bad",
        baseUrl: "https://driver.test",
        autoStopMs: 600_000,
        autoDeleteMs: Number.POSITIVE_INFINITY,
      }),
    ).toThrow("auto-delete")
  })

  test("normalizes driver-side provisioning responses", async () => {
    const driver = createFetchBridgeSandboxDriver({
      id: "http-test",
      baseUrl: "https://driver.test",
      fetch: vi.fn(async () => new Response(JSON.stringify({ status: "provisioning", retryAfterMs: 5_000 }))) as never,
      autoStopMs: 600_000,
      autoDeleteMs: 86_400_000,
    })

    await expect(
      driver.ensureHost({
        workspaceId: "ws_1",
        homeRegion: "us-east",
        epoch: 1,
        labels: { app: "claxedo" },
      }),
    ).resolves.toEqual({ provisioning: true, retryAfterMs: 5_000 })
  })

  test("lists driver runtime targets for manual garbage collection", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            targets: [
              {
                sandboxId: "sandbox_1",
                url: "https://runtime.test/ws_1",
                hostId: "host_1",
                driverResourceId: "driver_resource_1",
                labels: { app: "claxedo", workspaceId: "ws_1", epoch: "7" },
              },
            ],
          }),
        ),
    )
    const driver = createFetchBridgeSandboxDriver({
      id: "http-test",
      baseUrl: "https://driver.test",
      token: "secret",
      fetch: fetch as never,
      autoStopMs: 600_000,
      autoDeleteMs: 86_400_000,
    })

    await expect(driver.list?.()).resolves.toEqual([
      {
        sandboxId: "sandbox_1",
        url: "https://runtime.test/ws_1",
        hostId: "host_1",
        driverResourceId: "driver_resource_1",
        labels: { app: "claxedo", workspaceId: "ws_1", epoch: "7" },
      },
    ])
    expect(fetch).toHaveBeenCalledWith(
      "https://driver.test/runtime/list",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer secret" }),
        body: "{}",
      }),
    )
  })

  test("rejects targets without the canonical url field", async () => {
    const driver = createFetchBridgeSandboxDriver({
      id: "http-test",
      baseUrl: "https://driver.test",
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              sandboxId: "sandbox_1",
              runtimeUrl: "https://runtime.test/ws_legacy",
              hostId: "host_1",
            }),
          ),
      ) as never,
      autoStopMs: 600_000,
      autoDeleteMs: 86_400_000,
    })

    await expect(
      driver.ensureHost({
        workspaceId: "ws_1",
        homeRegion: "us-east",
        epoch: 1,
        labels: { app: "claxedo" },
      }),
    ).rejects.toThrow("Fetch bridge sandbox driver returned an incomplete target")
  })
})
