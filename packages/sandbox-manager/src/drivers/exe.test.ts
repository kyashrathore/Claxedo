import { describe, expect, test } from "vitest"
import { createExeSandboxDriver, exeWorkspaceName } from "./exe"
import { createSandboxManager } from ".."
import { createMemoryLeaseStore, sandboxLease } from "../stores/memory"

function fakeExe() {
  const vms = new Map<string, Record<string, unknown>>()
  const calls: Array<{ command: string; authorization: string | null }> = []
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
    const command = String(init?.body ?? "")
    const authorization = new Headers(init?.headers).get("authorization")
    calls.push({ command, authorization })
    if (command.startsWith("ls ")) {
      const requested = command.match(/^ls '([^']+)'$/)?.[1]
      return Response.json({
        vms: [...vms.values()].filter((vm) =>
          !requested || requested === "claxedo-ws-*" || vm.vm_name === requested
        ),
      })
    }
    if (command.startsWith("new ")) {
      const name = command.match(/--name='([^']+)'/)?.[1]
      if (!name) return Response.json({ error: "missing name" }, { status: 400 })
      // The provider persists --tag values and echoes them back on `ls`; the
      // fake must too, or it cannot exercise durable label recovery at all.
      const tags = [...command.matchAll(/--tag=(?:'([^']+)'|([^\s']+))/g)]
        .map((match) => match[1] ?? match[2])
        .filter((tag): tag is string => !!tag)
      const vm = { vm_name: name, https_url: `https://${name}.exe.xyz`, status: "running", tags }
      vms.set(name, vm)
      return Response.json(vm)
    }
    if (command.startsWith("ssh ")) {
      return Response.json({
        stdout: command.includes("curl -sf") ? "200" : "ok",
        stderr: "",
        exit_code: 0,
      })
    }
    if (command.startsWith("cp ")) {
      const names = [...command.matchAll(/'([^']+)'/g)].map((match) => match[1])
      const name = names[1]
      if (!name) return Response.json({ error: "missing clone name" }, { status: 400 })
      // `cp --copy-tags` carries the source VM's tags to the clone.
      const source = names[0] ? vms.get(names[0]) : undefined
      const vm = {
        vm_name: name,
        https_url: `https://${name}.exe.xyz`,
        status: "running",
        ...(command.includes("--copy-tags") && Array.isArray(source?.tags) ? { tags: source.tags } : {}),
      }
      vms.set(name, vm)
      return Response.json(vm)
    }
    if (command.startsWith("rm ")) {
      const name = command.match(/^rm '([^']+)'$/)?.[1]
      if (name) vms.delete(name)
      return Response.json({ ok: true })
    }
    return Response.json({ error: `unexpected command: ${command}` }, { status: 400 })
  }
  return { vms, calls, fetchImpl: fetchImpl as typeof fetch }
}

describe("exe.dev sandbox driver", () => {
  test("creates provider-safe stable workspace names", () => {
    const name = exeWorkspaceName("Workspace / With_UNSAFE Characters and a very long suffix", 42)
    expect(name).toMatch(/^claxedo-ws-[a-z0-9-]+-g42$/)
    expect(name.length).toBeLessThanOrEqual(63)
    expect(exeWorkspaceName("same", 1)).toBe(exeWorkspaceName("same", 1))
    expect(exeWorkspaceName("same", 2)).not.toBe(exeWorkspaceName("same", 1))
  })

  test("creates, inspects, executes, resumes, clones, and destroys with scoped bearer auth", async () => {
    const api = fakeExe()
    const driver = createExeSandboxDriver({
      apiToken: "exe-token",
      image: "ghcr.io/claxedo/runtime:0.6.0",
      healthIntervalMs: 0,
      fetchImpl: api.fetchImpl,
    })
    const ensure = {
      workspaceId: "workspace_1",
      homeRegion: "us-east",
      epoch: 3,
      hostId: "host_1",
      labels: { app: "claxedo", workspaceId: "workspace_1", epoch: "3" },
      env: { WORKSPACE_RUNTIME_EPOCH: "3" },
    }
    const created = await driver.ensureHost(ensure)
    if ("provisioning" in created) throw new Error("unexpected provisioning result")

    expect(created).toMatchObject({
      workspaceId: "workspace_1",
      sandboxId: exeWorkspaceName("workspace_1", 3),
      hostId: "host_1",
      driver: { id: "exe" },
    })
    expect(api.calls.find((call) => call.command.startsWith("new "))?.command).toContain(
      "--image='ghcr.io/claxedo/runtime:0.6.0'",
    )
    expect(api.calls.every((call) => call.authorization === "Bearer exe-token")).toBe(true)
    expect(api.calls.some((call) =>
      call.command.includes("WORKSPACE_RUNTIME_EPOCH") && call.command.includes("workspace-runtime")
    )).toBe(true)

    await expect(driver.inspect?.(created)).resolves.toMatchObject({ sandboxId: created.sandboxId })
    await expect(driver.exec?.(created, "printf disk-state")).resolves.toMatchObject({
      stdout: "ok",
      exitCode: 0,
    })
    await driver.stop?.(created)
    const resumed = await driver.resumeHost?.({
      lease: {
        workspaceId: "workspace_1",
        homeRegion: "us-east",
        driver: "exe",
        epoch: 3,
        status: "stopped",
        retryCount: 0,
        createdAt: 1,
        updatedAt: 1,
        sandboxId: created.sandboxId,
        hostId: created.hostId,
      },
      ensure,
    })
    expect(resumed && !("provisioning" in resumed) ? resumed.sandboxId : undefined).toBe(created.sandboxId)
    expect(api.calls.filter((call) => call.command.startsWith("new "))).toHaveLength(1)

    const cloned = await driver.clone?.(created, { name: "workspace-clone" })
    expect(cloned?.sandboxId).toBe(exeWorkspaceName("workspace-clone", 1))
    await driver.destroy?.(created)
    await expect(driver.inspect?.(created)).resolves.toBeUndefined()
  })

  test("reports Worker and Node compatibility with same-VM persistence and separate clone", () => {
    const driver = createExeSandboxDriver({ apiToken: "token", fetchImpl: fakeExe().fetchImpl })
    expect(driver.metadata).toMatchObject({
      driverRunsIn: ["worker", "node"],
      hostResumeBehavior: "same-host",
      persistence: {
        resume: "same-sandbox",
        capture: "none",
        clone: true,
      },
    })
  })
})

describe("exe.dev list() across a restart (W1 follow-up)", () => {
  // The bug: labels lived in a per-process Map, populated only on a successful
  // boot in THIS process. A fresh driver instance — Worker isolate recycle,
  // control-plane redeploy, or simply the GC cron running somewhere other than
  // the process that provisioned — listed the same VMs with `labels: undefined`,
  // and GC skips an unlabeled target as `unmanaged_app_label`. So no exe orphan
  // was ever reaped: the same invisible-orphan class as the Daytona/Cloudflare
  // gaps, just hidden behind a cache that happens to be warm in tests.
  function provision(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
    return createExeSandboxDriver({ apiToken: "t", healthIntervalMs: 0, fetchImpl }).ensureHost({
      workspaceId: "workspace_1",
      homeRegion: "us-east",
      epoch: 3,
      labels: { app: "claxedo", workspaceId: "workspace_1", epoch: "3" },
      ...overrides,
    })
  }

  test("a restarted driver recovers app/workspaceId/epoch from durable provider state", async () => {
    const api = fakeExe()
    await provision(api.fetchImpl)

    // The restart: a new driver over the SAME provider state, cold label cache.
    const restarted = createExeSandboxDriver({ apiToken: "t", healthIntervalMs: 0, fetchImpl: api.fetchImpl })
    const listed = await restarted.list?.()

    expect(listed).toHaveLength(1)
    expect(listed?.[0]?.labels).toMatchObject({ app: "claxedo", workspaceId: "workspace_1", epoch: "3" })
    expect(listed?.[0]?.workspaceId).toBe("workspace_1")
  })

  test("GC reaps an orphaned exe sandbox after a restart instead of silently skipping it", async () => {
    const api = fakeExe()
    const created = await provision(api.fetchImpl)
    if ("provisioning" in created) throw new Error("unexpected provisioning result")

    const restarted = createExeSandboxDriver({ apiToken: "t", healthIntervalMs: 0, fetchImpl: api.fetchImpl })
    // No lease at all: this VM is an orphan.
    const manager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver: restarted })

    const result = await manager.garbageCollect()

    expect(result.skipped).toEqual([])
    expect(result.destroyed.map((target) => target.sandboxId)).toEqual([created.sandboxId])
    expect(api.vms.has(created.sandboxId)).toBe(false)
  })

  test("a live lease's exe sandbox survives the same restarted sweep", async () => {
    // The other half of the contract: `hostId` must equal what the LEASE stores,
    // or a restarted sweep destroys a sandbox that is actively serving. The
    // supervisor writes a lease id as hostId, so this asserts the keep path with
    // a hostId that is NOT the VM name.
    const api = fakeExe()
    const created = await provision(api.fetchImpl, { hostId: "lease_abc" })
    if ("provisioning" in created) throw new Error("unexpected provisioning result")
    expect(created.hostId).toBe("lease_abc")

    const restarted = createExeSandboxDriver({ apiToken: "t", healthIntervalMs: 0, fetchImpl: api.fetchImpl })
    const manager = createSandboxManager({
      leaseStore: createMemoryLeaseStore([sandboxLease({
        workspaceId: "workspace_1",
        epoch: 3,
        status: "ready",
        sandboxId: created.sandboxId,
        url: created.url,
        hostId: "lease_abc",
      })]),
      driver: restarted,
    })

    const result = await manager.garbageCollect()

    expect(result.destroyed).toEqual([])
    expect(api.vms.has(created.sandboxId)).toBe(true)
  })

  test("a VM without the claxedo tag yields no labels, so GC skips rather than guesses", async () => {
    // `app` is the ownership gate GC destroys on. A VM we cannot prove we own
    // must never be handed a synthesized `app: "claxedo"`.
    const api = fakeExe()
    api.vms.set("claxedo-ws-foreign-abc-g1", {
      vm_name: "claxedo-ws-foreign-abc-g1",
      https_url: "https://foreign.exe.xyz",
      status: "running",
      tags: ["someone-else"],
    })
    const driver = createExeSandboxDriver({ apiToken: "t", healthIntervalMs: 0, fetchImpl: api.fetchImpl })

    const listed = await driver.list?.()
    expect(listed?.[0]?.labels).toBeUndefined()

    const manager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver })
    const result = await manager.garbageCollect()

    expect(result.destroyed).toEqual([])
    expect(result.skipped).toEqual([{ target: listed?.[0], reason: "unmanaged_app_label" }])
    expect(api.vms.has("claxedo-ws-foreign-abc-g1")).toBe(true)
  })
})
