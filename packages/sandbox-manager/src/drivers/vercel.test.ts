import { describe, expect, test, vi } from "vitest"
import { createVercelSandboxDriver, type VercelSandboxFactoryLike, type VercelSandboxLike } from "./vercel"

function sandbox(input: Partial<VercelSandboxLike> & { sandboxId?: string } = {}) {
  return {
    sandboxId: input.sandboxId ?? "vercel-sb-1",
    domain: input.domain ?? vi.fn((port: number) => `https://${input.sandboxId ?? "vercel-sb-1"}-${port}.vercel.run`),
    runCommand:
      input.runCommand ??
      vi.fn(async () => ({
        wait: vi.fn(async () => {}),
        kill: vi.fn(async () => {}),
        stdout: vi.fn(async () => ""),
      })),
    extendTimeout: input.extendTimeout ?? vi.fn(async () => {}),
    stop: input.stop ?? vi.fn(async () => ({})),
    snapshot: input.snapshot ?? vi.fn(async () => ({ snapshotId: `snap-${input.sandboxId ?? "vercel-sb-1"}` })),
    updateNetworkPolicy: input.updateNetworkPolicy ?? vi.fn(async (policy) => policy),
  } satisfies VercelSandboxLike
}

function factory(input: Partial<VercelSandboxFactoryLike> = {}) {
  return {
    create: input.create ?? vi.fn(async () => sandbox()),
    get: input.get ?? vi.fn(async (params: { sandboxId: string }) => sandbox({ sandboxId: params.sandboxId })),
  } satisfies VercelSandboxFactoryLike
}

const baseOptions = {
  token: "vercel-token",
  teamId: "team_1",
  projectId: "project_1",
  baseSnapshotId: "snap-base",
  runner: "opencode",
  controlEnv: {
    relayJwksUrl: "https://relay.test/.well-known/jwks.json",
    managementJwksUrl: "https://control.test/.well-known/jwks.json",
  },
}

const input = {
  workspaceId: "ws_1",
  homeRegion: "us-east" as const,
  epoch: 1,
  hostId: "vercel-host-ws_1",
  labels: { app: "claxedo", workspaceId: "ws_1" },
}

describe("VercelSandboxDriver", () => {
  test("brokered secrets are injected via a firewall header-transform network policy, never in env", async () => {
    const created = sandbox()
    const vercel = factory({ create: vi.fn(async () => created) })
    const driver = createVercelSandboxDriver({ ...baseOptions, sandbox: vercel })

    await driver.ensureHost({
      ...input,
      env: { MODEL_KEY: "sk-model" },
      secrets: [{ name: "NOTION_TOKEN", value: "ntn-secret", hosts: ["api.notion.com"], header: "Authorization" }],
    })

    expect(created.updateNetworkPolicy).toHaveBeenCalledWith(
      { allow: { "api.notion.com": [{ transform: [{ headers: { Authorization: "ntn-secret" } }] }] } },
      expect.anything(),
    )
    // The secret value is NOT in the create-time env passed to the sandbox.
    const createArg = (vercel.create as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(JSON.stringify(createArg.env)).not.toContain("ntn-secret")
  })

  test("brokered secret without a header is rejected (Vercel firewall injects a header)", async () => {
    const driver = createVercelSandboxDriver({ ...baseOptions, sandbox: factory() })
    await expect(
      driver.ensureHost({ ...input, secrets: [{ name: "X", value: "v", hosts: ["api.x.com"] }] }),
    ).rejects.toThrow(/header/)
  })

  test("ensureHost creates a sandbox from snapshot and starts workspace-runtime as a detached command", async () => {
    const created = sandbox()
    const vercel = factory({ create: vi.fn(async () => created) })
    const driver = createVercelSandboxDriver({
      ...baseOptions,
      sandbox: vercel,
      env: (_input, host) => ({
        WORKSPACE_RUNTIME_LEASE_ID: `lease-${host.id}`,
        WORKSPACE_RUNTIME_SANDBOX_ID: host.id,
      }),
    })

    const result = await driver.ensureHost({
      ...input,
      workspaceRoot: "/work/app",
      env: { CUSTOM_BOOT_FLAG: "yes" },
      source: { kind: "git", repoUrl: "https://repo.test/app.git", branch: "dev" },
    })
    if ("provisioning" in result) throw new Error("expected ready")

    expect(vercel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "vercel-token",
        teamId: "team_1",
        projectId: "project_1",
        source: { type: "snapshot", snapshotId: "snap-base" },
        ports: [2593],
        timeout: 30 * 60 * 1000,
        env: expect.objectContaining({
          WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_1",
          WORKSPACE_RUNTIME_HOST_ID: "vercel-host-ws_1",
          WORKSPACE_RUNTIME_DIRECTORY: "/work/app",
          WORKSPACE_RUNTIME_PORT: "2593",
          WORKSPACE_RUNTIME_RUNNER: "opencode",
          WORKSPACE_RUNTIME_RELAY_JWKS_URL: "https://relay.test/.well-known/jwks.json",
          WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL: "https://control.test/.well-known/jwks.json",
          WORKSPACE_RUNTIME_SOURCE_KIND: "git",
          WORKSPACE_RUNTIME_GIT_REPO_URL: "https://repo.test/app.git",
          WORKSPACE_RUNTIME_GIT_BRANCH: "dev",
          WORKSPACE_RUNTIME_LEASE_ID: "lease-vercel-host-ws_1",
          WORKSPACE_RUNTIME_SANDBOX_ID: "vercel-host-ws_1",
          CUSTOM_BOOT_FLAG: "yes",
        }),
      }),
    )
    expect(created.runCommand).toHaveBeenCalledTimes(1)
    expect(created.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: "bash",
        args: ["-lc", expect.stringContaining("/usr/local/bin/workspace-runtime")],
        detached: true,
        env: expect.objectContaining({ WORKSPACE_RUNTIME_HOST_ID: "vercel-host-ws_1" }),
      }),
    )
    expect(result).toMatchObject({
      sandboxId: "vercel-sb-1",
      hostId: "vercel-host-ws_1",
      url: "https://vercel-sb-1-2593.vercel.run",
      driverResourceId: "vercel-sb-1",
    })
    expect(result).not.toHaveProperty("runtimeUrl")
  })

  test("driver snapshot boot bypasses the default snapshot", async () => {
    const vercel = factory()
    const driver = createVercelSandboxDriver({ ...baseOptions, sandbox: vercel })

    await driver.ensureHost({
      ...input,
      bootSource: { kind: "driver-snapshot", snapshotId: "snap-runtime" },
    })

    expect(vercel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { type: "snapshot", snapshotId: "snap-runtime" },
      }),
    )
  })

  test("default boot builds and caches the Vercel snapshot when no base snapshot is configured", async () => {
    const builder = sandbox({ sandboxId: "builder" })
    const runtime = sandbox({ sandboxId: "runtime" })
    let creates = 0
    const vercel = factory({
      create: vi.fn(async () => {
        creates += 1
        return creates === 1 ? builder : runtime
      }),
    })
    const driver = createVercelSandboxDriver({
      ...baseOptions,
      baseSnapshotId: undefined,
      sandbox: vercel,
      snapshotCache: new Map(),
    })

    await driver.ensureHost(input)
    await driver.ensureHost({ ...input, workspaceId: "ws_2" })

    expect(vercel.create).toHaveBeenCalledTimes(3)
    expect(builder.runCommand).toHaveBeenCalledTimes(3)
    expect(builder.snapshot).toHaveBeenCalledWith(expect.objectContaining({ expiration: 0 }))
    const create = vercel.create as ReturnType<typeof vi.fn>
    expect(create.mock.calls[1]?.[0]).toMatchObject({
      source: { type: "snapshot", snapshotId: "snap-builder" },
    })
    expect(create.mock.calls[2]?.[0]).toMatchObject({
      source: { type: "snapshot", snapshotId: "snap-builder" },
    })
  })

  test("accepts a pre-seeded injected snapshot cache until its driver-local TTL expires", async () => {
    const clock = { t: 1_000 }
    const builder = sandbox({ sandboxId: "rebuilt" })
    const runtime = sandbox({ sandboxId: "runtime" })
    const vercel = factory({
      create: vi.fn()
        .mockResolvedValueOnce(runtime)
        .mockResolvedValueOnce(builder)
        .mockResolvedValueOnce(runtime),
    })
    const cache = new Map([["team_1:project_1:node22:0.5.1", "snap-seeded"]])
    const driver = createVercelSandboxDriver({
      ...baseOptions,
      baseSnapshotId: undefined,
      sandbox: vercel,
      snapshotCache: cache,
      now: () => clock.t,
    })

    await driver.ensureHost(input)
    expect((vercel.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      source: { type: "snapshot", snapshotId: "snap-seeded" },
    })

    clock.t += 60 * 60 * 1000 + 1
    await driver.ensureHost({ ...input, workspaceId: "ws_2" })
    expect(builder.snapshot).toHaveBeenCalledTimes(1)
  })

  test("concurrent snapshot misses share one in-flight build", async () => {
    const builder = sandbox({ sandboxId: "builder" })
    const runtimes = [sandbox({ sandboxId: "runtime-a" }), sandbox({ sandboxId: "runtime-b" })]
    let creates = 0
    const vercel = factory({
      create: vi.fn(async () => {
        creates += 1
        if (creates === 1) return builder
        return runtimes[creates - 2]!
      }),
    })
    const driver = createVercelSandboxDriver({
      ...baseOptions,
      baseSnapshotId: undefined,
      sandbox: vercel,
      snapshotCache: new Map(),
    })

    await Promise.all([
      driver.ensureHost(input),
      driver.ensureHost({ ...input, workspaceId: "ws_2" }),
    ])

    expect(builder.snapshot).toHaveBeenCalledTimes(1)
    expect(vercel.create).toHaveBeenCalledTimes(3)
  })

  test("network policy maps allow-all, deny-all, and host allowlists", async () => {
    const vercel = factory()
    const driver = createVercelSandboxDriver({ ...baseOptions, sandbox: vercel })

    await driver.ensureHost({ ...input, net: { mode: "allow-all" } })
    await driver.ensureHost({ ...input, net: { mode: "restricted", hosts: [] } })
    await driver.ensureHost({ ...input, net: { mode: "restricted", hosts: ["api.example.com"] } })

    const create = vercel.create as ReturnType<typeof vi.fn>
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("networkPolicy")
    expect(create.mock.calls[1]?.[0]).toMatchObject({ networkPolicy: "deny-all" })
    expect(create.mock.calls[2]?.[0]).toMatchObject({ networkPolicy: { allow: ["api.example.com"] } })
  })

  test("image boot is rejected and transient create failures are provisioning", async () => {
    const driver = createVercelSandboxDriver({ ...baseOptions, sandbox: factory() })
    await expect(
      driver.ensureHost({
        ...input,
        bootSource: { kind: "image", image: "ghcr.io/example/runtime:latest" },
      }),
    ).rejects.toThrow(/does not support image boot/)

    const unavailable = createVercelSandboxDriver({
      ...baseOptions,
      sandbox: factory({
        create: vi.fn(async () => {
          throw { status: 503, message: "unavailable" }
        }),
      }),
    })
    expect(await unavailable.ensureHost(input)).toEqual({ provisioning: true, retryAfterMs: 2_000 })
  })

  test("touch, stop, destroy, and snapshot operate by Vercel sandbox id", async () => {
    const item = sandbox({ sandboxId: "vercel-sb-2" })
    const vercel = factory({ get: vi.fn(async () => item) })
    const driver = createVercelSandboxDriver({ ...baseOptions, sandbox: vercel })
    const target = { sandboxId: "vercel-sb-2", url: "https://r.test", hostId: "vercel-host" }

    await driver.touch!(target)
    await driver.stop!(target)
    await driver.destroy!(target)
    const snap = await driver.snapshot!(target)

    expect(vercel.get).toHaveBeenCalledWith(expect.objectContaining({ sandboxId: "vercel-sb-2" }))
    expect(item.extendTimeout).toHaveBeenCalledWith(5 * 60 * 1000)
    expect(item.stop).toHaveBeenCalledWith({ blocking: false })
    expect(item.stop).toHaveBeenCalledWith({ blocking: true })
    expect(item.snapshot).toHaveBeenCalledWith(expect.objectContaining({ expiration: 0 }))
    expect(snap).toEqual({ snapshotId: "snap-vercel-sb-2" })
  })

  test("metadata exposes Vercel's direct sandbox-manager semantics", () => {
    const driver = createVercelSandboxDriver({ ...baseOptions, sandbox: factory() })
    expect(driver.metadata).toMatchObject({
      driverRunsIn: ["node"],
      hostStopBehavior: "terminates-host", hostResumeBehavior: "replacement-host",
      targetAccess: "relay",
    })
  })
})
