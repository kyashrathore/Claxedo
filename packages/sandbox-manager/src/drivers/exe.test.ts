import { describe, expect, test } from "vitest"
import { createExeSandboxDriver, exeWorkspaceName } from "./exe"

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
      const vm = { vm_name: name, https_url: `https://${name}.exe.xyz`, status: "running" }
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
      const vm = { vm_name: name, https_url: `https://${name}.exe.xyz`, status: "running" }
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
