import { describe, expect, test, vi } from "vitest"
import { fakeContainer, fakeStorage } from "./test-support/fake-container"

vi.mock("cloudflare:workers", () => ({
  DurableObject: class DurableObject {
    constructor(readonly ctx: unknown, readonly env: unknown) {}
  },
}))

const { WorkspaceSandbox } = await import("./workspace-sandbox")

const COMMAND = "/usr/local/bin/workspace-runtime"
const IDLE = { workspaceId: "ws_1", epoch: 3, port: 2593, idleMs: 600_000 }

function sandbox(options: Parameters<typeof fakeContainer>[0] = {}, env: Record<string, unknown> = {}) {
  const { container, state } = fakeContainer(options)
  const storage = fakeStorage()
  const egress: Array<{ sandboxId: string }> = []
  const ctx = {
    container,
    storage,
    blockConcurrencyWhile: async (run: () => Promise<void>) => await run(),
    exports: {
      CredentialEgress: ({ props }: { props: { sandboxId: string } }) => {
        egress.push(props)
        return { props }
      },
    },
  }
  const object = new WorkspaceSandbox(ctx as never, { CONTROL_PLANE_URL: "https://control.test", IDLE_STOP_TOKEN: "idle", ...env } as never)
  return { object, container, state, storage, egress }
}

async function ensure(object: InstanceType<typeof WorkspaceSandbox>, restore?: string) {
  await object.configureWorkspaceIdle(IDLE)
  return await object.ensureWorkspace({ command: COMMAND, env: {}, port: 2593, reuseRunning: true, ...(restore ? { restore } : {}) })
}

describe("workspace sandbox container", () => {
  test("a first ensure starts the runtime image with internet, a standard-1 instance and sleep as the main process, trusts the interception CA, and bounds inactivity", async () => {
    const s = sandbox()
    expect(await ensure(s.object)).toEqual({ state: "ready" })
    expect(s.state.starts).toEqual([{
      image: "registry.cloudflare.com/acct/claxedo-runtime@sha256:abc",
      entrypoint: ["sleep", "infinity"],
      enableInternet: true,
      instance: "standard-1",
    }])
    expect(s.state.intercepted).toEqual(["claxedo-credential-trust.invalid"])
    expect(s.state.inactivityTimeouts).toEqual([600_000])
  })

  test("a stopped workspace's checkpoint starts its container from that snapshot, never from the image", async () => {
    const s = sandbox()
    expect(await ensure(s.object, "snap-7")).toEqual({ state: "ready" })
    expect(s.state.starts).toEqual([{ containerSnapshot: { id: "snap-7" }, entrypoint: ["sleep", "infinity"], enableInternet: true, instance: "standard-1" }])
  })

  test("polls of a restore keep the container that snapshot started", async () => {
    const s = sandbox()
    await ensure(s.object, "snap-7")
    await ensure(s.object, "snap-7")
    expect(s.state.starts).toHaveLength(1)
    expect(s.state.destroys).toBe(0)
  })

  test("a restore over a container running from anything else replaces it, so the files the lease names are the ones served", async () => {
    const s = sandbox()
    await ensure(s.object)
    expect(await ensure(s.object, "snap-7")).toEqual({ state: "ready" })
    expect(s.state.destroys).toBe(1)
    expect(s.state.starts.map((start) => "containerSnapshot" in start ? start.containerSnapshot.id : "image")).toEqual(["image", "snap-7"])
  })

  test("a snapshot the platform no longer holds is refused as missing, with no container left and no start from the image", async () => {
    const s = sandbox({ missingSnapshots: ["snap-gone"] })
    expect(await ensure(s.object, "snap-gone")).toEqual({ state: "snapshot-missing" })
    expect(s.state.starts).toHaveLength(1)
    expect(s.container.running).toBe(false)
  })

  test("a container that cannot trust the interception CA is destroyed, so the next ensure starts a fresh one", async () => {
    const s = sandbox({ trustExit: 1 })
    await expect(ensure(s.object)).rejects.toThrow("did not trust the credential interception CA")
    expect(s.container.running).toBe(false)
    expect(s.state.destroys).toBe(1)
  })

  test("registered credential hosts are intercepted on every container start, at once on a running one, with this sandbox's own egress", async () => {
    const s = sandbox()
    await s.object.setCredentialHosts("claxedo-ws_1", ["api.anthropic.com", "api.anthropic.com"])
    expect(s.state.intercepted).toEqual([])
    await ensure(s.object)
    expect(s.state.intercepted).toEqual(["claxedo-credential-trust.invalid", "api.anthropic.com"])
    await s.object.setCredentialHosts("claxedo-ws_1", ["api.openai.com"])
    expect(s.state.intercepted.slice(2)).toEqual(["claxedo-credential-trust.invalid", "api.openai.com"])
    expect(s.egress.every((props) => props.sandboxId === "claxedo-ws_1")).toBe(true)
  })

  test("a restarted object re-registers its container's interceptions and inactivity bound", async () => {
    const s = sandbox()
    await s.object.setCredentialHosts("claxedo-ws_1", ["api.anthropic.com"])
    await ensure(s.object)
    const restarted = new WorkspaceSandbox({
      container: s.container,
      storage: s.storage,
      blockConcurrencyWhile: async (run: () => Promise<void>) => await run(),
      exports: { CredentialEgress: ({ props }: { props: unknown }) => ({ props }) },
    } as never, {} as never)
    await vi.waitFor(() => expect(s.state.inactivityTimeouts).toHaveLength(2))
    expect(restarted).toBeDefined()
    expect(s.state.intercepted.slice(2)).toEqual(["claxedo-credential-trust.invalid", "api.anthropic.com"])
  })
})

describe("workspace sandbox lifecycle", () => {
  test("a snapshot captures the running container and names it; a stopped one has nothing to capture", async () => {
    const s = sandbox()
    await expect(s.object.snapshotWorkspace()).rejects.toThrow("not running")
    await ensure(s.object)
    expect(await s.object.snapshotWorkspace()).toEqual({ snapshotId: "snap-1", sizeBytes: 4_096 })
  })

  test("a stop for this lease generation ends the container and its idle watch; an older generation's leaves it running", async () => {
    const s = sandbox()
    await ensure(s.object)
    await s.object.watchWorkspaceIdle()
    expect(await s.object.stopWorkspace(2)).toBe(false)
    expect(s.container.running).toBe(true)
    expect(await s.object.stopWorkspace(3)).toBe(true)
    expect(s.container.running).toBe(false)
    expect(s.storage.alarm()).toBeNull()
  })

  test("after a stop, a wake without a checkpoint starts from the image and launches a new runtime", async () => {
    const s = sandbox()
    await ensure(s.object)
    await s.object.stopWorkspace(3)
    expect(await ensure(s.object)).toEqual({ state: "ready" })
    expect(s.state.starts).toHaveLength(2)
    expect(s.state.launches.size).toBe(1)
  })

  test("destroy ends the container and forgets everything the object held", async () => {
    const s = sandbox()
    await s.object.setCredentialHosts("claxedo-ws_1", ["api.anthropic.com"])
    await ensure(s.object)
    await s.object.destroyWorkspace()
    expect(s.container.running).toBe(false)
    expect(s.storage.values.size).toBe(0)
  })

  test("the proxy reaches the runtime port of a running container and never starts one", async () => {
    const s = sandbox()
    expect((await s.object.fetch(new Request("https://sbx.test/global/event") as never)).status).toBe(503)
    expect(s.state.starts).toEqual([])
    await ensure(s.object)
    expect(await (await s.object.fetch(new Request("https://sbx.test/global/event") as never)).text()).toBe("proxied /global/event")
    expect(s.state.proxied).toEqual(["2593/global/event"])
  })

  test("a touch is ready only while the launched runtime answers", async () => {
    const s = sandbox()
    expect(await s.object.workspaceRuntimeReady(2593)).toBe(false)
    await ensure(s.object)
    expect(await s.object.workspaceRuntimeReady(2593)).toBe(true)
  })
})

describe("workspace idle watch", () => {
  test("an idle check probes the runtime with its own token, and a busy runtime is checked again", async () => {
    const s = sandbox()
    await ensure(s.object)
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true }))
    try {
      const probe = vi.spyOn(s.container, "getTcpPort")
      probe.mockReturnValue({ fetch: async () => Response.json({ workspaceId: "ws_1" }) })
      await s.object.alarm()
      expect(probe).toHaveBeenCalledWith(2593)
      expect(send).not.toHaveBeenCalled()
      expect(s.storage.alarm()).not.toBeNull()
    } finally {
      send.mockRestore()
    }
  })

  test("once the control plane stops the lease, the object stops its own container and schedules nothing more", async () => {
    const s = sandbox()
    await ensure(s.object)
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true, status: "stopped", checkpoint: "snap-1" }))
    try {
      vi.spyOn(s.container, "getTcpPort").mockReturnValue({ fetch: async () => Response.json({ workspaceId: "ws_1", idleSince: 0 }) })
      await s.object.alarm()
      expect(send).toHaveBeenCalledWith("https://control.test/internal/sandbox/idle-stop", expect.objectContaining({ method: "POST" }))
      expect(s.container.running).toBe(false)
      expect(s.storage.alarm()).toBeNull()
    } finally {
      send.mockRestore()
    }
  })

  test("idle checks that keep failing stop rescheduling, so the inactivity bound ends the container", async () => {
    const s = sandbox()
    await ensure(s.object)
    vi.spyOn(s.container, "getTcpPort").mockReturnValue({ fetch: async () => new Response("", { status: 500 }) })
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      for (let check = 0; check < 20; check++) {
        await s.storage.deleteAlarm()
        await s.object.alarm()
      }
      expect(s.storage.alarm()).toBeNull()
      expect(s.container.running).toBe(true)
    } finally {
      quiet.mockRestore()
    }
  })
})
