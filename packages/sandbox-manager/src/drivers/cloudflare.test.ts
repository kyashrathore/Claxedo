import { describe, expect, test, vi } from "vitest"
import { createCloudflareSandboxDriver } from "./cloudflare"
import { createSandboxManager } from ".."
import { createMemoryLeaseStore, sandboxLease } from "../stores/memory"

type Call = { url: string; method: string; body: any }

function harness(responder: (call: Call) => { status: number; json: any }) {
  const calls: Call[] = []
  const fetch = vi.fn(async (url: any, init: any) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    const { status, json } = responder(call)
    return new Response(JSON.stringify(json), { status })
  }) as unknown as typeof globalThis.fetch
  return { calls, fetch }
}

const baseOptions = {
  workerUrl: "https://sbx.example.com/",
  apiToken: "worker-secret",
  controlEnv: {
    relayJwksUrl: "https://relay.test/.well-known/jwks.json",
    managementJwksUrl: "https://control.test/.well-known/jwks.json",
  },
  runner: "opencode",
}

const createInput = {
  workspaceId: "ws_1",
  homeRegion: "us-east" as const,
  epoch: 7,
  labels: { app: "claxedo", workspaceId: "ws_1", epoch: "7" },
}

describe("CloudflareSandboxDriver", () => {
  test("ensureHost boots the runtime, sends the credential env, and returns the worker-proxied url", async () => {
    // The worker now returns its own data-plane proxy URL (no exposePort preview
    // subdomain) — the driver passes it through as the host URL unchanged.
    const proxyUrl = "https://sbx.example.com/sandbox/claxedo-ws_1/proxy"
    const { calls, fetch } = harness((call) => {
      if (call.url.endsWith("/ensure-runtime")) {
        return { status: 200, json: { ready: true, url: proxyUrl, port: 3002 } }
      }
      return { status: 200, json: { ok: true } }
    })

    const driver = createCloudflareSandboxDriver({ ...baseOptions, fetch })
    const result = await driver.ensureHost(createInput)

    expect("provisioning" in result).toBe(false)
    if ("provisioning" in result) throw new Error("unexpected provisioning")
    expect(result).toMatchObject({
      sandboxId: "claxedo-ws_1",
      hostId: "claxedo-ws_1",
      url: proxyUrl,
    })
    expect(result).not.toHaveProperty("runtimeUrl")

    const ensure = calls.find((c) => c.url.endsWith("/ensure-runtime"))!
    expect(ensure.method).toBe("POST")
    expect(ensure.url).toBe("https://sbx.example.com/sandbox/claxedo-ws_1/ensure-runtime")
    // credentials/config sent via the built-in env channel
    expect(ensure.body.env).toMatchObject({
      WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_1",
      WORKSPACE_RUNTIME_HOST_ID: "claxedo-ws_1",
      WORKSPACE_RUNTIME_DIRECTORY: "/workspace",
      WORKSPACE_RUNTIME_PORT: "2593",
      WORKSPACE_RUNTIME_RUNNER: "opencode",
      WORKSPACE_RUNTIME_RELAY_JWKS_URL: "https://relay.test/.well-known/jwks.json",
      WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL: "https://control.test/.well-known/jwks.json",
    })
    expect(ensure.body.port).toBe(2593)
    expect(typeof ensure.body.command).toBe("string")
  })

  test("brokered secrets are sent to the worker as egress registrations, never in container env", async () => {
    const { calls, fetch } = harness((call) =>
      call.url.endsWith("/ensure-runtime")
        ? { status: 200, json: { ready: true, url: "https://sbx.example.com/sandbox/claxedo-ws_1/proxy" } }
        : { status: 200, json: { ok: true } },
    )
    const driver = createCloudflareSandboxDriver({ ...baseOptions, fetch })

    await driver.ensureHost({
      ...createInput,
      env: { MODEL_KEY: "sk-model" },
      secrets: [{ name: "NOTION_TOKEN", value: "ntn-secret", hosts: ["api.notion.com"], header: "Authorization" }],
    })

    const ensure = calls.find((c) => c.url.endsWith("/ensure-runtime"))!
    // Egress registration carries the value server-to-server (API_TOKEN-gated).
    expect(ensure.body.egress).toEqual([
      { hosts: ["api.notion.com"], header: "Authorization", value: "ntn-secret" },
    ])
    // The value is NOT in the container env channel.
    expect(JSON.stringify(ensure.body.env)).not.toContain("ntn-secret")
  })

  test("brokered secret without a header is rejected", async () => {
    const { fetch } = harness(() => ({ status: 200, json: { url: "x" } }))
    const driver = createCloudflareSandboxDriver({ ...baseOptions, fetch })
    await expect(
      driver.ensureHost({ ...createInput, secrets: [{ name: "X", value: "v", hosts: ["api.x.com"] }] }),
    ).rejects.toThrow(/header/)
  })

  test("hostId on the returned target matches WORKSPACE_RUNTIME_HOST_ID injected into the sandbox (relay routing invariant)", async () => {
    const { calls, fetch } = harness(() => ({ status: 200, json: { ready: true, url: "https://r/", port: 3002 } }))
    const driver = createCloudflareSandboxDriver({ ...baseOptions, fetch })
    const result = await driver.ensureHost(createInput)
    if ("provisioning" in result) throw new Error("unexpected provisioning")
    const ensure = calls[0]
    expect(result.hostId).toBe(ensure.body.env.WORKSPACE_RUNTIME_HOST_ID)
  })

  test("merges ensureHost env, dynamic lease env, and workspaceRoot into the boot payload", async () => {
    const { calls, fetch } = harness(() => ({ status: 200, json: { ready: true, url: "https://r/", port: 2593 } }))
    const driver = createCloudflareSandboxDriver({
      ...baseOptions,
      fetch,
      env: async (_input, sandbox) => ({
        WORKSPACE_RUNTIME_LEASE_ID: `lease-${sandbox.id}`,
        WORKSPACE_RUNTIME_EPOCH: "3",
      }),
    })

    await driver.ensureHost({
      ...createInput,
      workspaceRoot: "/repo",
      env: { CUSTOM_BOOT_FLAG: "yes" },
      source: { kind: "git", repoUrl: "https://repo.test/app.git", branch: "dev" },
    })

    expect(calls[0].body.env).toMatchObject({
      WORKSPACE_RUNTIME_DIRECTORY: "/repo",
      WORKSPACE_RUNTIME_SOURCE_KIND: "git",
      WORKSPACE_RUNTIME_GIT_REPO_URL: "https://repo.test/app.git",
      WORKSPACE_RUNTIME_GIT_BRANCH: "dev",
      CUSTOM_BOOT_FLAG: "yes",
      WORKSPACE_RUNTIME_LEASE_ID: "lease-claxedo-ws_1",
      WORKSPACE_RUNTIME_EPOCH: "3",
    })
  })

  test("the Worker's explicit readiness 503 is reported as provisioning", async () => {
    const { fetch } = harness(() => ({
      status: 503,
      json: { error: "workspace-runtime did not become ready" },
    }))
    const driver = createCloudflareSandboxDriver({ ...baseOptions, fetch })
    const result = await driver.ensureHost(createInput)
    expect(result).toEqual({ provisioning: true, retryAfterMs: 2_000 })
  })

  test("permanent Worker configuration failures are not hidden as provisioning", async () => {
    const { fetch } = harness(() => ({
      status: 503,
      json: { error: "egress broker not configured (set EGRESS_SIGNING_SECRET + EGRESS_SECRETS)" },
    }))
    const driver = createCloudflareSandboxDriver({ ...baseOptions, fetch })
    await expect(driver.ensureHost(createInput)).rejects.toThrow(/egress broker not configured/)
  })

  test("timed-out ensure is reported as provisioning so callers can retry", async () => {
    const fetch = vi.fn((_url: unknown, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      }),
    ) as unknown as typeof globalThis.fetch
    const driver = createCloudflareSandboxDriver({ ...baseOptions, fetch, timeoutMs: 5 })

    expect(await driver.ensureHost(createInput)).toEqual({ provisioning: true, retryAfterMs: 2_000 })
  })

  test("the default ensure deadline spans the provider cold-start budget", async () => {
    const timeout = vi.spyOn(globalThis, "setTimeout")
    try {
      const { fetch } = harness(() => ({ status: 200, json: { ready: true, url: "https://r/" } }))
      const driver = createCloudflareSandboxDriver({ ...baseOptions, fetch })
      await driver.ensureHost(createInput)

      expect(timeout.mock.calls.some(([, delay]) => delay === 300_000)).toBe(true)
    } finally {
      timeout.mockRestore()
    }
  })

  test("4xx or missing url throws (real failure, not retried as provisioning)", async () => {
    const { fetch } = harness(() => ({ status: 400, json: { error: "bad request" } }))
    const driver = createCloudflareSandboxDriver({ ...baseOptions, fetch })
    await expect(driver.ensureHost(createInput)).rejects.toThrow(/ensure-runtime failed/)
  })

  test("destroy issues DELETE and tolerates 404", async () => {
    const seen: string[] = []
    const { fetch } = harness((call) => {
      seen.push(`${call.method} ${call.url}`)
      return { status: 404, json: {} }
    })
    const driver = createCloudflareSandboxDriver({ ...baseOptions, fetch })
    await driver.destroy!({ sandboxId: "claxedo-ws_1", url: "https://r/", hostId: "claxedo-ws_1" })
    expect(seen).toContain("DELETE https://sbx.example.com/sandbox/claxedo-ws_1")
  })

  test("touch refreshes the sandbox without throwing", async () => {
    const { calls, fetch } = harness(() => ({ status: 200, json: { ok: true } }))
    const driver = createCloudflareSandboxDriver({ ...baseOptions, fetch })
    await driver.touch!({ sandboxId: "claxedo-ws_1", url: "https://r/", hostId: "claxedo-ws_1" })
    expect(calls[0].url).toBe("https://sbx.example.com/sandbox/claxedo-ws_1/touch-runtime")
    expect(calls[0].body).toEqual({ port: 2593 })
  })

  test("captures declared directories and remounts a backup during replacement restore", async () => {
    const { calls, fetch } = harness((call) => {
      if (call.url.endsWith("/backup")) return { status: 200, json: { backupId: "backup-1" } }
      return { status: 200, json: { ready: true, url: "https://r/" } }
    })
    const driver = createCloudflareSandboxDriver({ ...baseOptions, fetch, workspaceDir: "/workspace" })

    await expect(driver.snapshot!({
      workspaceId: "ws_1",
      sandboxId: "claxedo-ws_1",
      url: "https://r/",
      hostId: "claxedo-ws_1",
    })).resolves.toEqual({ snapshotId: "backup-1" })
    await driver.ensureHost({
      ...createInput,
      bootSource: { kind: "driver-snapshot", snapshotId: "backup-1" },
    })

    // The runtime data dir is captured alongside the workspace so restoring a
    // sandbox cannot split durable runtime state from projected content.
    expect(calls.find((call) => call.url.endsWith("/backup"))?.body).toEqual({
      directories: ["/workspace", "/var/lib/claxedo"],
    })
    expect(calls.find((call) => call.url.endsWith("/ensure-runtime"))?.body.restore).toEqual({
      backupId: "backup-1",
      directories: ["/workspace", "/var/lib/claxedo"],
    })
  })

  test("captures the workspace root recorded by ensure instead of the driver default", async () => {
    const { calls, fetch } = harness((call) => {
      if (call.url.endsWith("/backup")) return { status: 200, json: { backupId: "backup-repo" } }
      return { status: 200, json: { ready: true, url: "https://r/" } }
    })
    const driver = createCloudflareSandboxDriver({ ...baseOptions, fetch, workspaceDir: "/workspace" })
    const target = await driver.ensureHost({ ...createInput, workspaceRoot: "/repo" })
    if ("provisioning" in target) throw new Error("unexpected provisioning")

    await driver.snapshot!(target)

    expect(calls.find((call) => call.url.endsWith("/backup"))?.body).toEqual({
      directories: ["/repo", "/var/lib/claxedo"],
    })
  })
})

describe("CloudflareSandboxDriver.list — Worker registry (W1.2)", () => {
  test("enumerates the Worker's registry and shapes GC-ready targets", async () => {
    const { calls, fetch } = harness((call) => {
      if (call.url.endsWith("/sandboxes")) {
        return {
          status: 200,
          json: {
            supported: true,
            sandboxes: [{ sandboxId: "claxedo-ws_1", app: "claxedo", workspaceId: "ws_1", epoch: "7" }],
          },
        }
      }
      return { status: 200, json: { ok: true } }
    })
    const driver = createCloudflareSandboxDriver({ ...baseOptions, fetch })

    await expect(driver.list?.()).resolves.toEqual([{
      workspaceId: "ws_1",
      sandboxId: "claxedo-ws_1",
      url: "https://sbx.example.com/sandbox/claxedo-ws_1/proxy",
      // Must equal ensureHost's hostId (= sandboxId) or GC would treat a live
      // sandbox as an orphan and destroy it.
      hostId: "claxedo-ws_1",
      driverResourceId: "claxedo-ws_1",
      labels: { app: "claxedo", workspaceId: "ws_1", epoch: "7" },
      driver: { id: "cloudflare", resourceId: "claxedo-ws_1" },
    }])
    expect(calls[0]).toMatchObject({ url: "https://sbx.example.com/sandboxes", method: "GET" })
  })

  test("ensureHost sends labels so the Worker can register the sandbox", async () => {
    const { calls, fetch } = harness(() => ({
      status: 200,
      json: { ready: true, url: "https://sbx.example.com/sandbox/claxedo-ws_1/proxy", port: 2593 },
    }))
    const driver = createCloudflareSandboxDriver({ ...baseOptions, fetch })

    await driver.ensureHost(createInput)

    // Without these the registry has no app/workspaceId/epoch, so GC could
    // neither prove ownership nor match a lease.
    expect(calls[0]?.body?.labels).toEqual({ app: "claxedo", workspaceId: "ws_1", epoch: "7" })
  })

  test("an un-upgraded Worker (404) is a loud capability gap, never an empty sweep", async () => {
    // The dangerous failure: returning [] here would make GC treat EVERY live
    // sandbox as an orphan and destroy the fleet. It must refuse to sweep.
    const { fetch } = harness(() => ({ status: 404, json: { error: "not found" } }))
    const driver = createCloudflareSandboxDriver({ ...baseOptions, fetch })

    await expect(driver.list?.()).rejects.toMatchObject({ listingUnsupported: true })

    const manager = createSandboxManager({
      leaseStore: createMemoryLeaseStore([sandboxLease({
        workspaceId: "ws_live",
        status: "ready",
        sandboxId: "claxedo-ws_live",
        url: "https://sbx.example.com/sandbox/claxedo-ws_live/proxy",
        hostId: "claxedo-ws_live",
      })]),
      driver,
    })

    await expect(manager.garbageCollect()).resolves.toMatchObject({
      listingUnsupported: true,
      driver: "cloudflare",
      destroyed: [],
    })
  })

  test("a Worker with no R2 binding reports supported:false, not an empty list", async () => {
    const { fetch } = harness(() => ({
      status: 501,
      json: { supported: false, error: "sandbox registry not configured (bind BACKUP_BUCKET)" },
    }))
    const driver = createCloudflareSandboxDriver({ ...baseOptions, fetch })

    await expect(driver.list?.()).rejects.toThrow(/BACKUP_BUCKET/)
  })

  test("a transient listing failure propagates as a real sweep failure", async () => {
    // 500 is NOT a capability gap: it must not be laundered into
    // `listingUnsupported`, which the cron deliberately does not alert on.
    const { fetch } = harness(() => ({ status: 500, json: { error: "r2 unavailable" } }))
    const driver = createCloudflareSandboxDriver({ ...baseOptions, fetch })

    await expect(driver.list?.()).rejects.toThrow(/Cloudflare sandbox listing failed \(500\)/)
    const manager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver })
    await expect(manager.garbageCollect()).rejects.toThrow(/r2 unavailable/)
  })
})
