import { describe, expect, test, vi } from "vitest"
import { createDaytonaSandboxDriver, type DaytonaClientLike, type DaytonaSandboxLike } from "./daytona"

function sandbox(input: Partial<DaytonaSandboxLike> & { id?: string } = {}) {
  const item: DaytonaSandboxLike = {
    id: input.id ?? "sb_1",
    state: input.state ?? "started",
    labels: input.labels ?? {},
    process: input.process ?? {
      executeCommand: vi.fn(async () => ({ exitCode: 0 })),
    },
    getPreviewLink:
      input.getPreviewLink ?? vi.fn(async () => ({ url: `https://preview-${input.id ?? "sb_1"}.daytona.app` })),
    getSignedPreviewUrl:
      input.getSignedPreviewUrl ??
      vi.fn(async () => ({
        url: `https://signed-${input.id ?? "sb_1"}.daytona.app`,
        token: "tok_1",
      })),
    refreshActivity: input.refreshActivity ?? vi.fn(async () => {}),
    start:
      input.start ??
      vi.fn(async () => {
        item.state = "started"
      }),
    stop:
      input.stop ??
      vi.fn(async () => {
        item.state = "stopped"
      }),
    delete:
      input.delete ??
      vi.fn(async () => {
        item.state = "destroyed"
      }),
  }
  return item
}

function client(input: Partial<DaytonaClientLike> = {}) {
  return {
    list: input.list ?? vi.fn(async () => ({ items: [] })),
    create: input.create ?? vi.fn(async () => sandbox()),
    get: input.get ?? vi.fn(async (id: string) => sandbox({ id })),
    upsertSecret: input.upsertSecret ?? vi.fn(async () => {}),
  } satisfies DaytonaClientLike
}

const baseOptions = {
  apiKey: "dtn-key",
  organizationId: "org_1",
  baseSnapshot: "claxedo/runtime:latest",
  controlEnv: {
    relayJwksUrl: "https://relay.test/jwks.json",
    managementJwksUrl: "https://control.test/.well-known/jwks.json",
  },
  runner: "opencode",
}
const input = {
  workspaceId: "ws_1",
  homeRegion: "us-east" as const,
  epoch: 1,
  labels: { app: "claxedo", workspaceId: "ws_1" },
}

describe("DaytonaSandboxDriver", () => {
  test("ensureHost creates a Daytona SDK sandbox with boot env and base snapshot", async () => {
    const created = sandbox()
    const daytona = client({ create: vi.fn(async () => created) })
    const driver = createDaytonaSandboxDriver({ ...baseOptions, client: daytona })

    const result = await driver.ensureHost(input)
    if ("provisioning" in result) throw new Error("expected ready")

    expect(daytona.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "claxedo-ws_1",
        snapshot: "claxedo/runtime:latest",
        public: false,
        labels: expect.objectContaining({ "claxedo.workspaceId": "ws_1" }),
        envVars: expect.objectContaining({
          WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_1",
          WORKSPACE_RUNTIME_HOST_ID: "claxedo-ws_1",
          WORKSPACE_RUNTIME_PORT: "2593",
          WORKSPACE_RUNTIME_RUNNER: "opencode",
          WORKSPACE_RUNTIME_RELAY_JWKS_URL: "https://relay.test/jwks.json",
          WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL: "https://control.test/.well-known/jwks.json",
        }),
      }),
      { timeout: 60 },
    )
    expect(result).toMatchObject({
      sandboxId: "sb_1",
      hostId: "claxedo-ws_1",
      url: "https://signed-sb_1.daytona.app",
    })
    expect(result).not.toHaveProperty("runtimeUrl")
  })

  test("brokered secrets are created as Daytona secrets and referenced, never in envVars/labels", async () => {
    const created = sandbox()
    const daytona = client({ create: vi.fn(async () => created) })
    const driver = createDaytonaSandboxDriver({ ...baseOptions, client: daytona })

    await driver.ensureHost({
      ...input,
      env: { MODEL_KEY: "sk-model" },
      secrets: [{ name: "NOTION_TOKEN", value: "ntn-secret", hosts: ["api.notion.com"] }],
    })

    expect(daytona.upsertSecret).toHaveBeenCalledWith({
      name: "claxedo-ws_1-NOTION_TOKEN",
      value: "ntn-secret",
      hosts: ["api.notion.com"],
    })
    const createArg = (daytona.create as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    // The env-var references the secret NAME (→ placeholder inside sandbox), not the value.
    expect(createArg.secrets).toEqual({ NOTION_TOKEN: "claxedo-ws_1-NOTION_TOKEN" })
    const serialized = JSON.stringify({ envVars: createArg.envVars, labels: createArg.labels })
    expect(serialized).not.toContain("ntn-secret")
  })

  test("brokered secret with an empty host allowlist is rejected", async () => {
    const driver = createDaytonaSandboxDriver({ ...baseOptions, client: client() })
    await expect(
      driver.ensureHost({ ...input, secrets: [{ name: "X", value: "v", hosts: [] }] }),
    ).rejects.toThrow(/host/)
  })

  test("ensureHost starts the sandbox process and returns preview token labels", async () => {
    const existing = sandbox()
    const daytona = client({ list: vi.fn(async () => ({ items: [existing] })) })
    const driver = createDaytonaSandboxDriver({ ...baseOptions, client: daytona })

    const result = await driver.ensureHost(input)
    if ("provisioning" in result) throw new Error("expected ready")

    expect(existing.process.executeCommand).toHaveBeenCalledWith(
      expect.stringContaining("/usr/local/bin/workspace-runtime"),
      "/workspace",
      expect.objectContaining({ WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_1" }),
      60,
    )
    expect(existing.getSignedPreviewUrl).toHaveBeenCalledWith(2593, 3600)
    expect(result.labels?.["daytona.previewToken"]).toBe("tok_1")
  })

  test("ensureHost passes git source materialization to the sandbox boot env", async () => {
    const executeCommand = vi.fn(async () => ({ result: "" }))
    const existing = sandbox({ process: { executeCommand } })
    const daytona = client({ list: vi.fn(async () => ({ items: [existing] })) })
    const driver = createDaytonaSandboxDriver({ ...baseOptions, client: daytona })

    await driver.ensureHost({
      ...input,
      workspaceRoot: "/work/app",
      source: { kind: "git", repoUrl: "https://repo.test/app.git", branch: "dev" },
    })

    expect(executeCommand).toHaveBeenCalledWith(
      expect.stringContaining("/usr/local/bin/workspace-runtime"),
      "/work/app",
      expect.objectContaining({
        WORKSPACE_RUNTIME_DIRECTORY: "/work/app",
        WORKSPACE_RUNTIME_SOURCE_KIND: "git",
        WORKSPACE_RUNTIME_GIT_REPO_URL: "https://repo.test/app.git",
        WORKSPACE_RUNTIME_GIT_BRANCH: "dev",
      }),
      60,
    )
    expect(executeCommand).toHaveBeenCalledTimes(1)
  })

  test("ensureHost supports image boot and sandbox-specific env", async () => {
    const created = sandbox({ id: "sb_image" })
    const createCalls: Parameters<DaytonaClientLike["create"]>[] = []
    const create: DaytonaClientLike["create"] = async (...args) => {
      createCalls.push(args)
      return created
    }
    const daytona = client({ create })
    const driver = createDaytonaSandboxDriver({
      ...baseOptions,
      client: daytona,
      env: (_input, item) => ({
        WORKSPACE_RUNTIME_LEASE_ID: "lease_1",
        WORKSPACE_RUNTIME_SANDBOX_ID: item.id,
      }),
    })

    await driver.ensureHost({
      ...input,
      bootSource: { kind: "image", image: "ghcr.io/example/runtime:latest" },
    })

    expect(createCalls[0]).toEqual([
      expect.objectContaining({
        image: "ghcr.io/example/runtime:latest",
      }),
      { timeout: 60 },
    ])
    expect(createCalls[0]?.[0]).not.toHaveProperty("snapshot")
    expect(created.process.executeCommand).toHaveBeenCalledWith(
      expect.stringContaining("/usr/local/bin/workspace-runtime"),
      "/workspace",
      expect.objectContaining({
        WORKSPACE_RUNTIME_LEASE_ID: "lease_1",
        WORKSPACE_RUNTIME_SANDBOX_ID: "sb_image",
      }),
      60,
    )
  })

  test("restricted network policy maps to Daytona SDK CIDR allowlist and full block", async () => {
    const daytona = client()
    const driver = createDaytonaSandboxDriver({ ...baseOptions, client: daytona })

    await driver.ensureHost({ ...input, net: { mode: "allow-all" } })
    await driver.ensureHost({ ...input, net: { mode: "restricted", hosts: ["api.example.test"], cidrs: ["10.0.0.0/8"] } })
    await driver.ensureHost({ ...input, net: { mode: "restricted", hosts: [], cidrs: [] } })

    const create = daytona.create as ReturnType<typeof vi.fn>
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("networkAllowList")
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("networkBlockAll")
    expect(create.mock.calls[1]?.[0]).toMatchObject({ networkAllowList: "10.0.0.0/8" })
    expect(create.mock.calls[2]?.[0]).toMatchObject({ networkBlockAll: true })
  })

  test("a stopped sandbox is started before returning a target", async () => {
    const stopped = sandbox({ state: "stopped" })
    const daytona = client({ list: vi.fn(async () => ({ items: [stopped] })) })
    const driver = createDaytonaSandboxDriver({ ...baseOptions, client: daytona })

    const result = await driver.ensureHost(input)
    if ("provisioning" in result) throw new Error("expected ready")

    expect(stopped.start).toHaveBeenCalledWith(60)
    expect(result).toMatchObject({ sandboxId: "sb_1" })
  })

  test("5xx or timeout SDK errors are provisioning, not terminal failures", async () => {
    const daytona = client({
      create: vi.fn(async () => {
        throw { response: { status: 502 }, message: "upstream" }
      }),
    })
    const driver = createDaytonaSandboxDriver({ ...baseOptions, client: daytona })
    expect(await driver.ensureHost(input)).toEqual({ provisioning: true, retryAfterMs: 2_000 })
  })

  test("destroy deletes and tolerates 404; stop calls SDK stop", async () => {
    const item = sandbox({
      delete: vi.fn(async () => {
        throw { response: { status: 404 } }
      }),
    })
    const daytona = client({ get: vi.fn(async () => item) })
    const driver = createDaytonaSandboxDriver({ ...baseOptions, client: daytona })
    const target = { sandboxId: "sb_1", url: "https://r/", hostId: "claxedo-ws_1" }

    await driver.destroy!(target)
    await driver.stop!(target)

    expect(item.delete).toHaveBeenCalledWith(60)
    expect(item.stop).toHaveBeenCalledWith(60)
  })

  test("metadata: can pause and resume the same resource", () => {
    const driver = createDaytonaSandboxDriver({ ...baseOptions, client: client() })
    expect(driver.metadata).toMatchObject({
      driverRunsIn: ["worker", "node"],
      hostStopBehavior: "suspends-host", hostResumeBehavior: "same-host",
      targetAccess: "relay",
    })
  })
})
