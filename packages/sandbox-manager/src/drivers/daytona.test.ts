import { describe, expect, test, vi } from "vitest"
import { createDaytonaSandboxDriver, type DaytonaClientLike, type DaytonaSandboxLike } from "./daytona"
import { createSandboxManager } from ".."
import { createMemoryLeaseStore, sandboxLease } from "../stores/memory"

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
    updateNetworkSettings: input.updateNetworkSettings ?? vi.fn(async () => {}),
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

  test("restricted network policy maps to Daytona's domain allowlist, CIDR allowlist and full block", async () => {
    const daytona = client()
    const driver = createDaytonaSandboxDriver({ ...baseOptions, client: daytona })

    await driver.ensureHost({ ...input, net: { mode: "allow-all" } })
    await driver.ensureHost({ ...input, net: { mode: "restricted", hosts: ["api.example.test"], cidrs: ["10.0.0.0/8"] } })
    await driver.ensureHost({ ...input, net: { mode: "restricted", hosts: [], cidrs: [] } })
    await driver.ensureHost({ ...input, net: { mode: "restricted", cidrs: ["10.0.0.0/8"] } })

    const create = daytona.create as ReturnType<typeof vi.fn>
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("networkAllowList")
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("domainAllowList")
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("networkBlockAll")
    // Names win over addresses when a policy carries both: the CIDRs are DNS
    // resolutions of the same hosts, and a pinned /32 goes stale the moment a
    // CDN-fronted host rotates IPs.
    expect(create.mock.calls[1]?.[0]).toMatchObject({ domainAllowList: "api.example.test" })
    expect(create.mock.calls[1]?.[0]).not.toHaveProperty("networkAllowList")
    expect(create.mock.calls[2]?.[0]).toMatchObject({ networkBlockAll: true })
    expect(create.mock.calls[3]?.[0]).toMatchObject({ networkAllowList: "10.0.0.0/8" })
  })

  test("reusing an existing sandbox reapplies the requested egress policy", async () => {
    // The policy only ever reaches `create` as creation parameters, so a reused
    // sandbox would otherwise run on whatever policy it was created with.
    const existing = sandbox({ id: "sb_existing" })
    const daytona = client({ list: vi.fn(async () => ({ items: [existing] })) })
    const driver = createDaytonaSandboxDriver({ ...baseOptions, client: daytona })

    const result = await driver.ensureHost({
      ...input,
      net: { mode: "restricted", hosts: ["api.example.test", "registry.npmjs.org"] },
    })
    if ("provisioning" in result) throw new Error("expected ready")

    expect(existing.updateNetworkSettings).toHaveBeenCalledWith({
      domainAllowList: "api.example.test,registry.npmjs.org",
    })
    expect(daytona.create).not.toHaveBeenCalled()
    expect(result).toMatchObject({ sandboxId: "sb_existing" })
  })

  test("the policy is applied after the sandbox starts and before the runtime boots", async () => {
    // updateNetworkSettings applies iptables rules to the RUNNING container, so
    // a stopped sandbox has nothing to apply them to; and readyTarget is what
    // boots the runtime, so landing in this window means no agent code has run
    // under the old policy.
    const order: string[] = []
    const existing = sandbox({ id: "sb_order", state: "stopped" })
    existing.start = vi.fn(async () => {
      order.push("start")
      existing.state = "started"
    })
    existing.updateNetworkSettings = vi.fn(async () => {
      order.push("policy")
    })
    existing.process.executeCommand = vi.fn(async () => {
      order.push("runtime")
      return { exitCode: 0 }
    })
    const daytona = client({ list: vi.fn(async () => ({ items: [existing] })) })
    const driver = createDaytonaSandboxDriver({ ...baseOptions, client: daytona })

    await driver.ensureHost({ ...input, net: { mode: "restricted", hosts: ["api.example.test"] } })

    expect(order).toEqual(["start", "policy", "runtime"])
  })

  test("resuming a sandbox reapplies the requested egress policy", async () => {
    const existing = sandbox({ id: "sb_resumed", state: "stopped" })
    const daytona = client({ get: vi.fn(async () => existing) })
    const driver = createDaytonaSandboxDriver({ ...baseOptions, client: daytona })

    const result = await driver.resumeHost!({
      lease: {
        workspaceId: "ws_1",
        homeRegion: "us-east",
        driver: "daytona",
        epoch: 1,
        status: "stopped",
        retryCount: 0,
        updatedAt: 1,
        createdAt: 1,
        sandboxId: "sb_resumed",
      },
      ensure: { ...input, net: { mode: "restricted", hosts: ["api.example.test"] } },
    })
    if ("provisioning" in result) throw new Error("expected ready")

    expect(existing.updateNetworkSettings).toHaveBeenCalledWith({ domainAllowList: "api.example.test" })
    expect(result).toMatchObject({ sandboxId: "sb_resumed" })
  })

  test("a deny-all policy and a CIDR policy are both reapplied on reuse", async () => {
    const denied = sandbox({ id: "sb_deny" })
    const denyClient = client({ list: vi.fn(async () => ({ items: [denied] })) })
    await createDaytonaSandboxDriver({ ...baseOptions, client: denyClient })
      .ensureHost({ ...input, net: { mode: "restricted", hosts: [], cidrs: [] } })
    expect(denied.updateNetworkSettings).toHaveBeenCalledWith({ networkBlockAll: true })

    const cidr = sandbox({ id: "sb_cidr" })
    const cidrClient = client({ list: vi.fn(async () => ({ items: [cidr] })) })
    await createDaytonaSandboxDriver({ ...baseOptions, client: cidrClient })
      .ensureHost({ ...input, net: { mode: "restricted", cidrs: ["10.0.0.0/8"] } })
    expect(cidr.updateNetworkSettings).toHaveBeenCalledWith({ networkAllowList: "10.0.0.0/8" })
  })

  test("no requested policy leaves the existing sandbox's policy untouched", async () => {
    // "No containment requested" is not "remove the restriction" — clearing it
    // is the one direction that widens egress nobody asked to widen.
    const existing = sandbox({ id: "sb_existing" })
    const daytona = client({ list: vi.fn(async () => ({ items: [existing] })) })
    const driver = createDaytonaSandboxDriver({ ...baseOptions, client: daytona })

    await driver.ensureHost({ ...input, net: { mode: "allow-all" } })
    await driver.ensureHost(input)

    expect(existing.updateNetworkSettings).not.toHaveBeenCalled()
  })

  test("reuse is refused when the client cannot reapply the policy", async () => {
    // Serving the creation-time policy would report containment that is not in
    // force, which is worse than handing back no sandbox.
    const legacy = sandbox({ id: "sb_legacy" })
    delete legacy.updateNetworkSettings
    const daytona = client({ list: vi.fn(async () => ({ items: [legacy] })) })
    const driver = createDaytonaSandboxDriver({ ...baseOptions, client: daytona })

    await expect(
      driver.ensureHost({ ...input, net: { mode: "restricted", hosts: ["api.example.test"] } }),
    ).rejects.toThrow(/updateNetworkSettings/)
  })

  test("a transient failure reapplying the policy is provisioning, never a target", async () => {
    const flaky = sandbox({
      id: "sb_flaky",
      updateNetworkSettings: vi.fn(async () => {
        throw { response: { status: 503 }, message: "unavailable" }
      }),
    })
    const daytona = client({ list: vi.fn(async () => ({ items: [flaky] })) })
    const driver = createDaytonaSandboxDriver({ ...baseOptions, client: daytona })

    expect(
      await driver.ensureHost({ ...input, net: { mode: "restricted", hosts: ["api.example.test"] } }),
    ).toEqual({ provisioning: true, retryAfterMs: 2_000 })
    expect(flaky.process.executeCommand).not.toHaveBeenCalled()
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

  test("lifecycle intervals reach Daytona's create call as minutes", async () => {
    const daytona = client({ create: vi.fn(async () => sandbox()) })
    const driver = createDaytonaSandboxDriver({
      ...baseOptions,
      client: daytona,
      autoStopMinutes: 30,
      autoDeleteMinutes: 1440,
    })

    await driver.ensureHost(input)

    expect((daytona.create as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
      autoStopInterval: 30,
      autoDeleteInterval: 1440,
    })
  })

  test("omitted lifecycle intervals are left off the create call, not sent as zero", async () => {
    const daytona = client({ create: vi.fn(async () => sandbox()) })
    const driver = createDaytonaSandboxDriver({ ...baseOptions, client: daytona })

    await driver.ensureHost(input)

    // Daytona reads 0 as "immediately": autoStop 0 DISABLES idle stop, and
    // autoDelete 0 marks the sandbox ephemeral — deleted with its filesystem
    // the moment it stops. An absent option must stay absent so the provider
    // applies its own defaults (15-minute auto-stop, auto-delete off).
    const createArg = (daytona.create as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(createArg).not.toHaveProperty("autoStopInterval")
    expect(createArg).not.toHaveProperty("autoDeleteInterval")
  })
})

describe("DaytonaSandboxDriver.list (W1.1)", () => {
  test("returns only claxedo-labeled sandboxes as GC-shaped targets", async () => {
    const daytona = client({
      list: vi.fn(async () => ({
        items: [
          sandbox({ id: "sb_managed", labels: { app: "claxedo", "claxedo.workspaceId": "ws_1", epoch: "3" } }),
          // Someone else's sandbox in the same Daytona org: no claxedo label,
          // so GC must never even see it, let alone destroy it.
          sandbox({ id: "sb_foreign", labels: { team: "other" } }),
        ],
      })),
    })
    const driver = createDaytonaSandboxDriver({ ...baseOptions, client: daytona })

    await expect(driver.list?.()).resolves.toEqual([{
      workspaceId: "ws_1",
      sandboxId: "sb_managed",
      url: "sb_managed",
      hostId: "claxedo-ws_1",
      driverResourceId: "sb_managed",
      labels: { app: "claxedo", "claxedo.workspaceId": "ws_1", epoch: "3" },
      driver: { id: "daytona", resourceId: "sb_managed" },
    }])
  })

  test("walks every page until one comes back short", async () => {
    const page = (ids: string[]) => ({
      items: ids.map((id) => sandbox({ id, labels: { app: "claxedo", "claxedo.workspaceId": id } })),
    })
    const full = Array.from({ length: 100 }, (_, index) => `sb_${index}`)
    const list = vi.fn(async (_labels?: unknown, pageNumber?: number) =>
      pageNumber === 1 ? page(full) : pageNumber === 2 ? page(["sb_tail"]) : page([]))
    const driver = createDaytonaSandboxDriver({ ...baseOptions, client: client({ list }) })

    const targets = await driver.list?.()

    // Page 1 is full (100 = the page size) so the walk continues; page 2 is
    // short and ends it. An orphan on a later page is exactly the thing a
    // single-page sweep would miss.
    expect(list).toHaveBeenCalledTimes(2)
    expect(targets).toHaveLength(101)
    expect(targets?.at(-1)?.sandboxId).toBe("sb_tail")
  })

  test("a listing failure throws rather than reporting an empty account", async () => {
    // Degrading to [] here would tell the GC sweep "nothing is orphaned" — the
    // silent success this workstream exists to remove.
    const daytona = client({ list: vi.fn(async () => { throw new Error("daytona 503") }) })
    const driver = createDaytonaSandboxDriver({ ...baseOptions, client: daytona })

    await expect(driver.list?.()).rejects.toThrow("daytona 503")
  })

  test("a client with no list capability throws instead of returning nothing", async () => {
    const daytona = { ...client(), list: undefined } as DaytonaClientLike
    const driver = createDaytonaSandboxDriver({ ...baseOptions, client: daytona })

    await expect(driver.list?.()).rejects.toThrow(/does not support listing/)
  })

  test("sees a sandbox carrying only the manager's flat labels", async () => {
    // The manager writes flat `app`/`workspaceId`/`epoch` labels; the dotted
    // `claxedo.workspaceId` is this driver's own addition for findExisting. GC
    // reads the FLAT ones, so a filter keyed only on the dotted label would
    // make a manager-provisioned orphan invisible — the exact defect W1 removes.
    const daytona = client({
      list: vi.fn(async () => ({
        items: [sandbox({ id: "sb_flat", labels: { app: "claxedo", workspaceId: "ws_flat", epoch: "4" } })],
      })),
    })
    const driver = createDaytonaSandboxDriver({ ...baseOptions, client: daytona })

    const targets = await driver.list?.()

    expect(targets).toHaveLength(1)
    expect(targets?.[0]).toMatchObject({ sandboxId: "sb_flat", workspaceId: "ws_flat" })
    // Labels are passed through exactly as the provider reported them, so GC's
    // own app/epoch checks see real provider state rather than a reconstruction.
    expect(targets?.[0]?.labels).toEqual({ app: "claxedo", workspaceId: "ws_flat", epoch: "4" })
  })
})


describe("Daytona sandbox GC end-to-end (W1 positive control)", () => {
  // The whole-workstream control: the REAL Daytona driver behind the REAL
  // manager, sweeping a sandbox the lease table has never heard of. Before
  // W1.1 the driver had no `list()`, so `garbageCollect()` returned four empty
  // arrays and this sandbox lived until the provider expired it.
  test("a Daytona sandbox with no lease is enumerated and destroyed", async () => {
    const orphan = sandbox({
      id: "sb_orphan",
      labels: { app: "claxedo", workspaceId: "ws_orphan", epoch: "1", "claxedo.workspaceId": "ws_orphan" },
    })
    const driver = createDaytonaSandboxDriver({
      ...baseOptions,
      client: client({
        list: vi.fn(async () => ({ items: [orphan] })),
        get: vi.fn(async () => orphan),
      }),
    })
    const manager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver })

    const result = await manager.garbageCollect()

    expect(result.listingUnsupported).toBeUndefined()
    expect(result.destroyed.map((target) => target.sandboxId)).toEqual(["sb_orphan"])
    expect(orphan.delete).toHaveBeenCalled()
  })

  test("a live lease's sandbox survives the same sweep", async () => {
    const live = sandbox({
      id: "sb_live",
      labels: { app: "claxedo", workspaceId: "ws_live", epoch: "2", "claxedo.workspaceId": "ws_live" },
    })
    const driver = createDaytonaSandboxDriver({
      ...baseOptions,
      client: client({ list: vi.fn(async () => ({ items: [live] })), get: vi.fn(async () => live) }),
    })
    const manager = createSandboxManager({
      leaseStore: createMemoryLeaseStore([sandboxLease({
        workspaceId: "ws_live",
        epoch: 2,
        status: "ready",
        sandboxId: "sb_live",
        url: "https://preview.daytona.app/live",
        // Must match the driver's derived hostId — `labelName(workspaceId)`.
        hostId: "claxedo-ws_live",
      })]),
      driver,
    })

    const result = await manager.garbageCollect()

    expect(result.kept.map((target) => target.sandboxId)).toEqual(["sb_live"])
    expect(result.destroyed).toEqual([])
    expect(live.delete).not.toHaveBeenCalled()
  })
})
