import { describe, expect, test } from "vitest"
import { createBoxSandboxDriver, type BoxFetch } from "./box"
import type { SandboxDriverEnsureInput } from ".."

type Call = { path: string; method: string; body?: any }

function ensureInput(overrides?: Partial<SandboxDriverEnsureInput>): SandboxDriverEnsureInput {
  return {
    workspaceId: "ws1",
    homeRegion: "eu",
    epoch: 1,
    labels: { app: "claxedo", workspaceId: "ws1", epoch: "1" },
    bootSource: { kind: "default" },
    workspaceRoot: "/workspace",
    workspaceRuntimePort: 2593,
    env: {},
    ...overrides,
  }
}

/**
 * Simulates the Box REST API: box creation → ready state → command execution
 * (docker run / host / health probe / host url). Records every call so tests
 * can assert on the boot sequence.
 */
function fakeBox(options?: { states?: string[]; hostUrl?: string; failHealthOnce?: boolean }) {
  const calls: Call[] = []
  const states = options?.states ?? ["ready"]
  let stateIdx = 0
  let healthChecks = 0
  const hostUrl = options?.hostUrl ?? "https://sub-2593.on.ascii.dev?_token=tok"

  const fetchImpl: BoxFetch = async (input, init) => {
    const path = input.replace("https://ascii.dev/api/box/v1", "")
    const method = init?.method ?? "GET"
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path, method, body })

    const json = (obj: unknown) =>
      new Response(JSON.stringify({ ok: true, ...(obj as object) }), { status: 200 })

    if (path === "/boxes" && method === "POST") {
      return json({ type: "box.created", box: { id: "bx_abc123", state: "provisioning" } })
    }
    if (path === "/boxes/bx_abc123" && method === "GET") {
      const state = states[Math.min(stateIdx, states.length - 1)]
      stateIdx++
      return json({ box: { id: "bx_abc123", state } })
    }
    if (path === "/boxes/bx_abc123/commands" && method === "POST") {
      const command: string = body.command
      if (command.includes("/global/health")) {
        healthChecks++
        const healthy = options?.failHealthOnce ? healthChecks > 1 : true
        return json({ stdout: healthy ? "200" : "000", stderr: "", exitCode: 0 })
      }
      if (command.startsWith("host url")) {
        return json({ stdout: `${hostUrl}\n`, stderr: "", exitCode: 0 })
      }
      return json({ stdout: "", stderr: "", exitCode: 0 })
    }
    if (path === "/boxes/bx_abc123/stop" && method === "POST") return json({ type: "box.archiving" })
    if (path === "/boxes/bx_abc123/resume" && method === "POST") return json({ type: "box.resumed" })
    if (path === "/boxes/bx_abc123" && method === "DELETE") return json({ type: "box.deleted" })
    return new Response(JSON.stringify({ ok: false, error: `unhandled ${method} ${path}` }), { status: 404 })
  }
  return { fetchImpl, calls, get healthChecks() { return healthChecks } }
}

describe("box sandbox driver", () => {
  test("exposes relay metadata and box identity", () => {
    const driver = createBoxSandboxDriver({ apiKey: "k", fetchImpl: async () => new Response("{}") })
    expect(driver.id).toBe("box")
    expect(driver.metadata).toMatchObject({
      driverRunsIn: ["node"],
      hostStopBehavior: "suspends-host",
      hostResumeBehavior: "same-host",
      targetAccess: "relay",
      secretBrokering: "none",
    })
  })

  test("boots a box: create → poll ready → docker run → host → health → url", async () => {
    const box = fakeBox({ states: ["provisioning", "ready"] })
    const driver = createBoxSandboxDriver({
      apiKey: "k",
      image: "ghcr.io/test/sandbox:1",
      fetchImpl: box.fetchImpl,
      provisionIntervalMs: 0,
      healthIntervalMs: 0,
    })

    const target = await driver.ensureHost(ensureInput())
    expect("provisioning" in target).toBe(false)
    if ("provisioning" in target) throw new Error("unexpected provisioning")

    expect(target.sandboxId).toBe("bx_abc123")
    expect(target.url).toBe("https://sub-2593.on.ascii.dev?_token=tok")
    expect(target.driver).toEqual({ id: "box", resourceId: "bx_abc123" })

    const commands = box.calls.filter((c) => c.path.endsWith("/commands")).map((c) => c.body.command as string)
    const dockerRun = commands.find((c) => c.includes("docker run"))
    expect(dockerRun).toContain("ghcr.io/test/sandbox:1")
    expect(dockerRun).toContain("-p 2593:2593")
    expect(dockerRun).toContain("WORKSPACE_RUNTIME_WORKSPACE_ID=ws1")
    expect(commands.some((c) => c === "host 2593")).toBe(true)
    expect(commands.some((c) => c === "host url 2593")).toBe(true)
  })

  test("retries the health probe until the runtime answers 200", async () => {
    const box = fakeBox({ failHealthOnce: true })
    const driver = createBoxSandboxDriver({ apiKey: "k", fetchImpl: box.fetchImpl, healthIntervalMs: 0 })
    const target = await driver.ensureHost(ensureInput())
    if ("provisioning" in target) throw new Error("unexpected provisioning")
    expect(box.healthChecks).toBeGreaterThanOrEqual(2)
  })

  test("passes ttlSeconds:null by default so the manager owns the lifecycle", async () => {
    const box = fakeBox()
    const driver = createBoxSandboxDriver({ apiKey: "k", fetchImpl: box.fetchImpl, healthIntervalMs: 0 })
    await driver.ensureHost(ensureInput())
    const create = box.calls.find((c) => c.path === "/boxes" && c.method === "POST")
    expect(create?.body).toEqual({ ttlSeconds: null })
  })

  test("rejects restricted network policy", async () => {
    const box = fakeBox()
    const driver = createBoxSandboxDriver({ apiKey: "k", fetchImpl: box.fetchImpl })
    await expect(
      driver.ensureHost(ensureInput({ net: { mode: "restricted", hosts: ["example.com"] } })),
    ).rejects.toThrow(/network policy/)
  })

  test("stop archives and destroy deletes the box", async () => {
    const box = fakeBox()
    const driver = createBoxSandboxDriver({ apiKey: "k", fetchImpl: box.fetchImpl })
    const target = {
      workspaceId: "ws1",
      sandboxId: "bx_abc123",
      url: "https://x",
      hostId: "box-ws1",
    }
    await driver.stop?.(target)
    await driver.destroy?.(target)
    expect(box.calls.some((c) => c.path === "/boxes/bx_abc123/stop" && c.method === "POST")).toBe(true)
    expect(box.calls.some((c) => c.path === "/boxes/bx_abc123" && c.method === "DELETE")).toBe(true)
  })

  test("resume brings the same box back and re-establishes the runtime", async () => {
    const box = fakeBox()
    const driver = createBoxSandboxDriver({ apiKey: "k", fetchImpl: box.fetchImpl, healthIntervalMs: 0 })
    const target = await driver.resumeHost?.({
      lease: { sandboxId: "bx_abc123", hostId: "box-ws1" } as any,
      ensure: ensureInput(),
    })
    if (!target || "provisioning" in target) throw new Error("unexpected provisioning")
    expect(target.sandboxId).toBe("bx_abc123")
    expect(box.calls.some((c) => c.path === "/boxes/bx_abc123/resume" && c.method === "POST")).toBe(true)
  })
})
