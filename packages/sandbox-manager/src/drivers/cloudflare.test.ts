import { describe, expect, test, vi } from "vitest"
import { createCloudflareSandboxDriver } from "./cloudflare"

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

  test("cold container (5xx) is reported as provisioning, not a failure", async () => {
    const { fetch } = harness(() => ({ status: 503, json: { error: "container booting" } }))
    const driver = createCloudflareSandboxDriver({ ...baseOptions, fetch })
    const result = await driver.ensureHost(createInput)
    expect(result).toEqual({ provisioning: true, retryAfterMs: 2_000 })
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
})
