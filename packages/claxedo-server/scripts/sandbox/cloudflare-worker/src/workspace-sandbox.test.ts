import { describe, expect, test, vi } from "vitest"
import { fakeContainer, fakeStorage, IMAGE_RUNTIME_DIGEST } from "./test-support/fake-container"

vi.mock("cloudflare:workers", () => ({
  DurableObject: class DurableObject {
    constructor(readonly ctx: unknown, readonly env: unknown) {}
  },
}))

const { WorkspaceSandbox } = await import("./workspace-sandbox")

const COMMAND = "/usr/local/bin/workspace-runtime"
const IDLE = { workspaceId: "ws_1", epoch: 3, port: 2593, idleMs: 600_000 }
const BUILD = { RUNTIME_BUILD_ID: "build-1", RUNTIME_VERSION: "0.5.2", RUNTIME_DIGEST: IMAGE_RUNTIME_DIGEST }

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
  const object = new WorkspaceSandbox(ctx as never, { CONTROL_PLANE_URL: "https://control.test", IDLE_STOP_TOKEN: "idle", ...BUILD, ...env } as never)
  return { object, container, state, storage, egress }
}

const BOOT_ENV = { WORKSPACE_RUNTIME_DIRECTORY: "/workspace", HOME: "/home/claxedo" }

async function ensure(object: InstanceType<typeof WorkspaceSandbox>, restore?: string, more: { minimumRuntimeVersion?: string; reuseRunning?: boolean } = {}) {
  await object.configureWorkspaceIdle(IDLE)
  return await object.ensureWorkspace({ command: COMMAND, env: BOOT_ENV, port: 2593, reuseRunning: more.reuseRunning ?? true, ...(restore ? { restore } : {}), ...more })
}

const NEW_DIGEST = "a".repeat(64)

/** The same sandbox after a deploy whose image carries runtime 0.6.0. */
function redeployed(s: ReturnType<typeof sandbox>) {
  s.state.imageDigest = NEW_DIGEST
  return new WorkspaceSandbox({
    container: s.container,
    storage: s.storage,
    blockConcurrencyWhile: async (run: () => Promise<void>) => await run(),
    exports: { CredentialEgress: ({ props }: { props: unknown }) => ({ props }) },
  } as never, { CONTROL_PLANE_URL: "https://control.test", IDLE_STOP_TOKEN: "idle", RUNTIME_BUILD_ID: "build-2", RUNTIME_VERSION: "0.6.0", RUNTIME_DIGEST: NEW_DIGEST } as never)
}

/** A workspace that ran under runtime 0.5.2 and left files in its repository, HOME and a system directory before it was saved. */
async function savedWithFiles(s: ReturnType<typeof sandbox>) {
  await ensure(s.object)
  s.state.files.set("/workspace/src/edit.ts", "the person's edit")
  s.state.files.set("/home/claxedo/.workspace-runtime/store.db", "sessions")
  s.state.files.set("/usr/local/lib/node_modules/cowsay/cli.js", "a global install")
  const { snapshotId } = await s.object.snapshotWorkspace()
  await s.object.stopWorkspace(IDLE.epoch)
  return snapshotId
}

/** A workspace that ran, was captured and was stopped, as an idle stop leaves it. */
async function saved(s: ReturnType<typeof sandbox>) {
  await ensure(s.object)
  const { snapshotId } = await s.object.snapshotWorkspace()
  await s.object.stopWorkspace(IDLE.epoch)
  return snapshotId
}

const INIT = ["/usr/bin/tini", "--", "sleep", "infinity"]
const RESTORED_START = { entrypoint: INIT, enableInternet: true, instance: "standard-1" }

describe("workspace sandbox container", () => {
  test("a first ensure starts the runtime image with internet, a standard-1 instance and an init that reaps orphans as the main process, trusts the interception CA, and bounds inactivity", async () => {
    const s = sandbox()
    expect(await ensure(s.object)).toEqual({ state: "ready" })
    expect(s.state.starts).toEqual([{
      image: "registry.cloudflare.com/acct/claxedo-runtime@sha256:abc",
      entrypoint: INIT,
      enableInternet: true,
      instance: "standard-1",
    }])
    expect(s.state.intercepted).toEqual(["claxedo-credential-trust.invalid"])
    expect(s.state.inactivityTimeouts).toEqual([600_000])
  })

  test("a stopped workspace's checkpoint starts from its snapshot with the image environment recorded when it was taken, never from the image", async () => {
    const s = sandbox()
    const snapshotId = await saved(s)
    expect(await ensure(s.object, snapshotId)).toEqual({ state: "ready" })
    expect(s.state.starts.at(-1)).toEqual({
      ...RESTORED_START,
      containerSnapshot: { id: snapshotId },
      env: { PATH: "/root/.local/bin:/usr/local/bin:/usr/bin", AMP_SKIP_UPDATE_CHECK: "1" },
    })
    expect([...s.state.launches.values()].at(-1)?.env.PATH).toBe("/root/.local/bin:/usr/local/bin:/usr/bin")
  })

  test("polls of a restore keep the container that snapshot started", async () => {
    const s = sandbox()
    const snapshotId = await saved(s)
    await ensure(s.object, snapshotId)
    await ensure(s.object, snapshotId)
    expect(s.state.starts).toHaveLength(2)
  })

  test("a restore over a container running from anything else replaces it, so the files the lease names are the ones served", async () => {
    const s = sandbox()
    const snapshotId = await saved(s)
    await ensure(s.object)
    expect(await ensure(s.object, snapshotId)).toEqual({ state: "ready" })
    expect(s.state.starts.map((start) => "containerSnapshot" in start ? start.containerSnapshot.id : "image")).toEqual(["image", "image", snapshotId])
  })

  test("a snapshot the platform no longer holds is refused as expired, with no container left and no start from the image", async () => {
    const s = sandbox({ missingSnapshots: ["snap-1"] })
    const snapshotId = await saved(s)
    expect(await ensure(s.object, snapshotId)).toEqual({ state: "checkpoint-unusable", cause: "expired" })
    expect(s.state.starts.map((start) => "image" in start)).toEqual([true, false])
    expect(s.container.running).toBe(false)
  })

  test("a snapshot id this sandbox never took is refused before anything starts, so a handle from another sandbox restores nothing", async () => {
    const s = sandbox()
    expect(await ensure(s.object, "snap-of-another-sandbox")).toEqual({ state: "checkpoint-unusable", cause: "not_restorable" })
    expect(s.state.starts).toEqual([])
  })

  test("a snapshot recorded without the init its container ran under is not restored, since its filesystem need not carry one", async () => {
    const s = sandbox()
    const snapshotId = await saved(s)
    const key = `claxedo.snapshot:${snapshotId}`
    const { entrypoint: _init, ...older } = s.storage.values.get(key) as Record<string, unknown>
    s.storage.values.set(key, older)
    expect(await ensure(s.object, snapshotId)).toEqual({ state: "checkpoint-unusable", cause: "not_restorable" })
    expect(s.state.starts).toHaveLength(1)
  })

  test("destroying a sandbox revokes every snapshot it took", async () => {
    const s = sandbox()
    const snapshotId = await saved(s)
    await s.object.destroyWorkspace()
    expect(await ensure(s.object, snapshotId)).toEqual({ state: "checkpoint-unusable", cause: "not_restorable" })
    expect(s.state.starts).toHaveLength(1)
  })

  test("a checkpoint saved below the control plane's minimum runtime keeps the repository and HOME in a container from the current image, which runs the current runtime", async () => {
    const s = sandbox()
    const snapshotId = await savedWithFiles(s)
    const object = redeployed(s)
    expect(await ensure(object, snapshotId, { minimumRuntimeVersion: "0.6.0" })).toEqual({ state: "ready" })
    const [carry, image] = s.state.starts.slice(-2)
    expect(carry).toEqual({ containerSnapshot: { id: snapshotId }, env: { PATH: "/root/.local/bin:/usr/local/bin:/usr/bin", AMP_SKIP_UPDATE_CHECK: "1" }, entrypoint: INIT, enableInternet: false, instance: "standard-1" })
    expect(image).toMatchObject({ image: "registry.cloudflare.com/acct/claxedo-runtime@sha256:abc", entrypoint: INIT, enableInternet: true })
    expect(s.state.directorySnapshotsTaken).toEqual(["/workspace", "/home/claxedo"])
    expect(Object.fromEntries(s.state.files)).toEqual({
      "/workspace/src/edit.ts": "the person's edit",
      "/home/claxedo/.workspace-runtime/store.db": "sessions",
    })
    expect(s.state.runtimeDigest).toBe(NEW_DIGEST)
    expect(s.state.launches.size).toBe(1)
    expect((await object.snapshotWorkspace()).runtimeBuild).toBe("build-2")
  })

  test("the checkpoint a carried workspace saves next restores as it was saved, with no second carry", async () => {
    const s = sandbox()
    const saved = await savedWithFiles(s)
    const object = redeployed(s)
    await ensure(object, saved, { minimumRuntimeVersion: "0.6.0" })
    const { snapshotId } = await object.snapshotWorkspace()
    await object.stopWorkspace(IDLE.epoch)
    const taken = s.state.directorySnapshotsTaken.length
    expect(await ensure(object, snapshotId, { minimumRuntimeVersion: "0.6.0" })).toEqual({ state: "ready" })
    expect(s.state.starts.at(-1)).toMatchObject({ containerSnapshot: { id: snapshotId }, enableInternet: true })
    expect(s.state.directorySnapshotsTaken).toHaveLength(taken)
    expect(s.state.files.get("/workspace/src/edit.ts")).toBe("the person's edit")
  })

  test("polls of a carried restore keep the container the carry started", async () => {
    const s = sandbox()
    const snapshotId = await savedWithFiles(s)
    const object = redeployed(s)
    await ensure(object, snapshotId, { minimumRuntimeVersion: "0.6.0" })
    const starts = s.state.starts.length
    expect(await ensure(object, snapshotId, { minimumRuntimeVersion: "0.6.0" })).toEqual({ state: "ready" })
    expect(s.state.starts).toHaveLength(starts)
  })

  test("a carry that cannot copy the files fails the start with its reason and leaves the checkpoint as it was, so the next ensure carries it again", async () => {
    const s = sandbox()
    const snapshotId = await savedWithFiles(s)
    const object = redeployed(s)
    s.state.placeFails = true
    await expect(ensure(object, snapshotId, { minimumRuntimeVersion: "0.6.0" })).rejects.toThrow("The workspace's /workspace could not be carried into the current image: cp: No space left on device")
    expect(s.container.running).toBe(false)
    s.state.placeFails = false
    expect(await ensure(object, snapshotId, { minimumRuntimeVersion: "0.6.0" })).toEqual({ state: "ready" })
    expect(s.state.files.get("/workspace/src/edit.ts")).toBe("the person's edit")
  })

  test("a below-minimum checkpoint whose runtime was changed inside the machine is carried too, since nothing of it runs", async () => {
    const s = sandbox()
    await ensure(s.object)
    s.state.runtimeDigest = "e".repeat(64)
    const { snapshotId } = await s.object.snapshotWorkspace()
    await s.object.stopWorkspace(IDLE.epoch)
    expect(await ensure(redeployed(s), snapshotId, { minimumRuntimeVersion: "0.6.0" })).toEqual({ state: "ready" })
    expect(s.state.runtimeDigest).toBe(NEW_DIGEST)
  })

  test("a below-minimum checkpoint the platform no longer holds is refused as expired", async () => {
    const s = sandbox({ missingSnapshots: ["snap-1"] })
    const snapshotId = await saved(s)
    expect(await ensure(redeployed(s), snapshotId, { minimumRuntimeVersion: "0.6.0" })).toEqual({ state: "checkpoint-unusable", cause: "expired" })
    expect(s.container.running).toBe(false)
    expect(s.state.directorySnapshotsTaken).toEqual([])
  })

  test("a checkpoint at the minimum restores whole, system files and its own runtime included", async () => {
    const s = sandbox()
    const snapshotId = await savedWithFiles(s)
    expect(await ensure(s.object, snapshotId, { minimumRuntimeVersion: "0.5.2" })).toEqual({ state: "ready" })
    expect(s.state.files.get("/usr/local/lib/node_modules/cowsay/cli.js")).toBe("a global install")
    expect(s.state.directorySnapshotsTaken).toEqual([])
  })

  test("a snapshot whose runtime files were changed inside the machine is destroyed unlaunched", async () => {
    const s = sandbox()
    await ensure(s.object)
    s.state.runtimeDigest = "e".repeat(64)
    const { snapshotId } = await s.object.snapshotWorkspace()
    await s.object.stopWorkspace(IDLE.epoch)
    expect(await ensure(s.object, snapshotId)).toEqual({ state: "checkpoint-unusable", cause: "runtime_modified" })
    expect(s.container.running).toBe(false)
    expect(s.state.launches.size).toBe(0)
  })

  test("a relaunch into a running container whose runtime files changed is refused, so the changed runtime never gets the boot env", async () => {
    const s = sandbox()
    await ensure(s.object)
    s.state.runtimeDigest = "e".repeat(64)
    expect(await ensure(s.object, undefined, { reuseRunning: false })).toEqual({ state: "checkpoint-unusable", cause: "runtime_modified" })
    expect(s.container.running).toBe(false)
  })

  test("an image that does not carry this Worker's runtime build is an operator error, and nothing launches", async () => {
    const s = sandbox({}, { RUNTIME_DIGEST: "f".repeat(64) })
    await expect(ensure(s.object)).rejects.toThrow("does not carry this Worker's runtime build build-1")
    expect(s.container.running).toBe(false)
  })

  test("a container whose launch directory cannot be memory-backed is destroyed, so no runtime output reaches a snapshot", async () => {
    const s = sandbox({ memoryRootExit: 1 })
    await expect(ensure(s.object)).rejects.toThrow("no memory-backed runtime directory")
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
  test("a snapshot captures the running container and names it with its runtime build; a stopped one has nothing to capture", async () => {
    const s = sandbox()
    await expect(s.object.snapshotWorkspace()).rejects.toThrow("not running")
    await ensure(s.object)
    expect(await s.object.snapshotWorkspace()).toEqual({ snapshotId: "snap-1", sizeBytes: 4_096, runtimeBuild: "build-1" })
  })

  test("only the newest eight snapshot records are kept", async () => {
    const s = sandbox()
    await ensure(s.object)
    for (let taken = 0; taken < 10; taken++) await s.object.snapshotWorkspace()
    const recorded = [...s.storage.values.keys()].filter((key) => key.startsWith("claxedo.snapshot:"))
    expect(recorded).toHaveLength(8)
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

  test("a running container whose runtime stopped listening answers the relay's unavailable envelope, never a platform exception page", async () => {
    const s = sandbox()
    await ensure(s.object)
    for (const launch of s.state.launches.values()) launch.state = "exited"
    const response = await s.object.fetch(new Request("https://sbx.test/session/ses_1/outline") as never)
    expect([response.status, await response.json()]).toEqual([503, { error: { code: "upstream_unavailable", message: "The workspace runtime is not answering" } }])
    expect(s.state.starts).toHaveLength(1)
  })

  test("a running container whose runtime died is still snapshotted, and its restore launches a new runtime on that snapshot", async () => {
    const s = sandbox()
    await ensure(s.object)
    for (const launch of s.state.launches.values()) launch.state = "exited"
    const { snapshotId } = await s.object.snapshotWorkspace()
    await s.object.stopWorkspace(IDLE.epoch)
    expect(await ensure(s.object, snapshotId)).toEqual({ state: "ready" })
    expect(s.state.starts.at(-1)).toMatchObject({ containerSnapshot: { id: snapshotId } })
    expect([...s.state.launches.values()].at(-1)?.state).toBe("running")
  })

  test("a sandbox with no running container answers the same envelope", async () => {
    const response = await sandbox().object.fetch(new Request("https://sbx.test/session/ses_1/outline") as never)
    expect([response.status, await response.json()]).toEqual([503, { error: { code: "upstream_unavailable", message: "The workspace machine is not running" } }])
  })

  test("the container runs from its ensure until its stop", async () => {
    const s = sandbox()
    expect(await s.object.workspaceRunning()).toBe(false)
    await ensure(s.object)
    expect(await s.object.workspaceRunning()).toBe(true)
    await s.object.stopWorkspace(3)
    expect(await s.object.workspaceRunning()).toBe(false)
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

describe("workspace runtime log", () => {
  function runningLaunch(s: ReturnType<typeof sandbox>) {
    const [launch] = s.state.launches.values()
    if (!launch) throw new Error("no runtime launched")
    return launch
  }

  test("each idle check forwards the runtime's own new warnings to the Worker's log once, and never what a harness wrote to stderr", async () => {
    const s = sandbox()
    await ensure(s.object)
    vi.spyOn(s.container, "getTcpPort").mockReturnValue({ fetch: async () => Response.json({ workspaceId: "ws_1" }) })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      const launch = runningLaunch(s)
      expect(launch.env.WORKSPACE_RUNTIME_OPERATOR_LOG).toBe(`${launch.dir}/operator.log`)
      launch.stderr = "2026-10-16T12:18:25 WARN  claude: user prompt was: rotate the prod keys\n"
      launch.operator = "2026-10-16T12:18:31 WARN  Session authority unavailable service=session-authority action=write sessionId=ses_1 ms=5003 cause=timeout\n"
      await s.object.alarm()
      await s.object.alarm()
      launch.operator += "2026-10-16T12:19:02 ERROR CLAXEDO_API_TOKEN=secret-value\n"
      await s.object.alarm()
      expect(warn.mock.calls.map(([message, record]) => [message, record])).toEqual([
        ["workspace-runtime log", { workspaceId: "ws_1", epoch: 3, launchId: expect.any(String), lines: ["2026-10-16T12:18:31 WARN  Session authority unavailable service=session-authority action=write sessionId=ses_1 ms=5003 cause=timeout"], dropped: 0, skippedBytes: 0 }],
        ["workspace-runtime log", expect.objectContaining({ lines: ["2026-10-16T12:19:02 ERROR CLAXEDO_API_TOKEN=[REDACTED]"] })],
      ])
      expect(JSON.stringify(warn.mock.calls)).not.toContain("prompt")
    } finally {
      warn.mockRestore()
    }
  })

  test("a stop forwards what the runtime logged since the last check before the container and its memory-backed log are gone", async () => {
    const s = sandbox()
    await ensure(s.object)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      runningLaunch(s).operator = "2026-10-16T12:19:02 ERROR last words\n"
      expect(await s.object.stopWorkspace(3)).toBe(true)
      expect(s.container.running).toBe(false)
      expect(warn).toHaveBeenCalledWith("workspace-runtime log", expect.objectContaining({ lines: ["2026-10-16T12:19:02 ERROR last words"] }))
      expect([...s.storage.values.keys()].filter((key) => key.includes("runtime-log"))).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  test("an ensure retried after a launch whose answer was lost ends that launch, so the runtime that serves is the recorded one whose log is forwarded", async () => {
    const s = sandbox()
    s.state.launchAnswerLost = new Error("Network connection lost.")
    await expect(ensure(s.object)).rejects.toThrow("Network connection lost.")
    expect(await ensure(s.object)).toEqual({ state: "ready" })
    expect(s.state.launches.size).toBe(1)
    vi.spyOn(s.container, "getTcpPort").mockReturnValue({ fetch: async () => Response.json({ workspaceId: "ws_1" }) })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      runningLaunch(s).operator = "2026-10-16T18:20:58 WARN  Event loop blocked service=workspace-runtime maxBlockedMs=6308\n"
      await s.object.alarm()
      expect(warn).toHaveBeenCalledWith("workspace-runtime log", expect.objectContaining({ lines: ["2026-10-16T18:20:58 WARN  Event loop blocked service=workspace-runtime maxBlockedMs=6308"] }))
    } finally {
      warn.mockRestore()
    }
  })

  test("a log read that fails never holds up the stop", async () => {
    const s = sandbox()
    await ensure(s.object)
    s.state.logReadFailure = new Error("exec refused")
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      expect(await s.object.stopWorkspace(3)).toBe(true)
      expect(s.container.running).toBe(false)
      expect(quiet).toHaveBeenCalledWith("workspace-runtime log forward failed", expect.objectContaining({ error: "Error: exec refused" }))
    } finally {
      quiet.mockRestore()
    }
  })
})
