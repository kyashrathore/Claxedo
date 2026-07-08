import { describe, expect, test, vi } from "vitest"
import { createFetchBridgeSandboxDriver } from "./fetch-bridge"

describe("fetch sandbox driver", () => {
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
