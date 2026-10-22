import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createBoatSandboxDriver, type BoatFetch } from "./boat"
import type { SandboxDriverEnsureInput } from "../contract"
import { sandboxLease } from "../stores/memory"
import { preparedImageOutput } from "./boat-preparation.test-support"

const ID = "bx_23456789"
const API = "https://boat.dev/api/v1"
const IMAGE = "ghcr.io/test/sandbox:1"
const HOLD_MS = 60_000

const ensureInput = (overrides?: Partial<SandboxDriverEnsureInput>): SandboxDriverEnsureInput => ({
  workspaceId: "ws1",
  homeRegion: "eu",
  epoch: 1,
  labels: { app: "claxedo", workspaceId: "ws1", epoch: "1" },
  bootSource: { kind: "default" },
  workspaceRoot: "/workspace",
  workspaceRuntimePort: 2593,
  env: {},
  ...overrides,
})

const sandbox = (state: string) => ({ id: ID, state, hydrated: true })
const json = (value: object, status = 200) => Response.json({ ok: true, ...value }, { status })
const finished = (stdout = "") => json({ type: "command.finished", success: true, exitCode: 0, stdout, stderr: "", timedOut: false })
const at = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms - Date.now())))

/**
 * Boat on a clock: the sandbox is ready from `readyAt`, archived from
 * `archivedAt`, and a command sent before `readyAt` is held until then, or
 * refused as still starting once Boat's 60 s hold ends (docs.boat.dev/readiness).
 */
function clockedBoat(input: { readyAt: number; archivedAt?: number }) {
  const calls: Array<{ at: number; method: string; path: string; command?: string; timeoutSeconds?: number }> = []
  let resumed = false
  const state = () => {
    if (input.archivedAt !== undefined && !resumed) return Date.now() >= input.archivedAt ? "archived" : "archiving"
    return Date.now() >= input.readyAt ? "ready" : "provisioning"
  }
  const fetchImpl: BoatFetch = async (url, init) => {
    const path = url.replace(API, "")
    const method = init?.method ?? "GET"
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    calls.push({ at: Date.now(), method, path, command: body?.command, timeoutSeconds: body?.timeoutSeconds })
    if (path === "/sandboxes") return json({ type: "sandbox.created", sandbox: sandbox("provisioning") }, 202)
    if (path === `/sandboxes/${ID}` && method === "GET") return json({ type: "sandbox.info", sandbox: sandbox(state()) })
    if (path === `/sandboxes/${ID}` && method === "PATCH") return json({ type: "sandbox.updated", sandbox: sandbox(state()) })
    if (path.endsWith("/resume")) {
      resumed = true
      return json({ type: "sandbox.resuming", sandbox: sandbox("provisioning") }, 202)
    }
    if (path.endsWith("/files")) return json({ type: "file.written", success: true })
    if (path.endsWith("/commands")) {
      if (state() === "provisioning") {
        const sentAt = Date.now()
        await at(Math.min(input.readyAt, sentAt + HOLD_MS))
        if (Date.now() < input.readyAt) return Response.json({ ok: false, code: "boat_starting", message: "still starting" }, { status: 409 })
      }
      if (body.command.includes("/global/health")) return finished("200\nrunning\n")
      if (body.command.startsWith("host url")) return finished("https://machine-2593.on.boat.dev\n")
      if (body.command.includes("docker info")) return finished(preparedImageOutput(body.command))
      return finished()
    }
    return Response.json({ ok: false, code: "unhandled", message: `${method} ${path}` }, { status: 404 })
  }
  return { fetchImpl, calls }
}

/** Runs the fake clock one timer at a time, letting each timer's promise chain finish, until `pending` settles. */
async function settled<T>(pending: Promise<T>): Promise<T> {
  let done = false
  const tracked = pending.finally(() => { done = true })
  tracked.catch(() => undefined)
  for (let timers = 0; timers < 1_000; timers++) {
    for (let turn = 0; turn < 100; turn++) await Promise.resolve()
    if (done) return tracked
    vi.advanceTimersToNextTimer()
  }
  throw new Error("still pending after 1,000 timers")
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: 0 })
})

afterEach(() => {
  vi.useRealTimers()
})

describe("the Boat driver's waits", () => {
  test.each([300, 1_100, 4_500, 12_000])("a sandbox ready %i ms after its create is booted the moment Boat holds it ready, with no read between", async (readyAt) => {
    const boat = clockedBoat({ readyAt })
    let machineReadyAt: number | undefined
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: boat.fetchImpl })
    const booted = driver.ensureHost(ensureInput({ onMachineReady: async () => { machineReadyAt = Date.now() } }))
    await expect(settled(booted)).resolves.toMatchObject({ sandboxId: ID })
    expect(machineReadyAt).toBe(readyAt)
    expect(boat.calls.filter((call) => call.method === "GET")).toEqual([])
  })

  test("a start that outlasts Boat's hold is asked again at once, and one that outlasts the provisioning window is the next step's to wait for", async () => {
    const slow = clockedBoat({ readyAt: 75_000 })
    let machineReadyAt: number | undefined
    const booted = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: slow.fetchImpl })
      .ensureHost(ensureInput({ onMachineReady: async () => { machineReadyAt = Date.now() } }))
    await expect(settled(booted)).resolves.toMatchObject({ sandboxId: ID })
    expect(machineReadyAt).toBe(75_000)
    expect(slow.calls.filter((call) => call.command === "true").map((call) => call.at)).toEqual([0, HOLD_MS])

    const stuck = clockedBoat({ readyAt: 1_000_000 })
    const startedAt = Date.now()
    const waited = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: stuck.fetchImpl, provisionTimeoutMs: 120_000 }).ensureHost(ensureInput())
    await expect(settled(waited)).resolves.toEqual({ provisioning: true, retryAfterMs: 0 })
    expect(stuck.calls.filter((call) => call.command === "true").map((call) => call.at - startedAt)).toEqual([0, HOLD_MS])
  })

  test("a command Boat refuses as not running fails a sandbox in error at once, and waits 2 s on one whose state still reads as starting", async () => {
    const refusing = (states: string[]): BoatFetch => async (url, init) => {
      const path = url.replace(API, "")
      if (path === "/sandboxes") return json({ type: "sandbox.created", sandbox: sandbox("provisioning") }, 202)
      const command = typeof init?.body === "string" ? JSON.parse(init.body).command : undefined
      if (path.endsWith("/commands") && command === "true" && states.length > 1) {
        return Response.json({ ok: false, code: "machine_not_running", message: "not running" }, { status: 409 })
      }
      if (path === `/sandboxes/${ID}` && (init?.method ?? "GET") === "GET") return json({ type: "sandbox.info", sandbox: sandbox(states.shift() ?? "ready") })
      return clockedBoat({ readyAt: 0 }).fetchImpl(url, init)
    }
    await expect(createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: refusing(["error", "error"]) }).ensureHost(ensureInput()))
      .rejects.toThrow(`Boat ${ID} entered non-ready state: error`)

    let machineReadyAt: number | undefined
    const booted = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: refusing(["provisioning", "ready"]) })
      .ensureHost(ensureInput({ onMachineReady: async () => { machineReadyAt = Date.now() } }))
    await expect(settled(booted)).resolves.toMatchObject({ sandboxId: ID })
    expect(machineReadyAt).toBe(2_000)
  })

  test("a sandbox still archiving is read again after 250 ms, doubling to 2 s, and resumed the read after its archive ends", async () => {
    const boat = clockedBoat({ archivedAt: 6_000, readyAt: 0 })
    const resumed = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: boat.fetchImpl }).resumeHost!({
      lease: sandboxLease({ workspaceId: "ws1", sandboxId: ID, hostId: "boat-ws1", url: "https://runtime.test", status: "stopped" }),
      ensure: ensureInput(),
    })
    await expect(settled(resumed)).resolves.toMatchObject({ sandboxId: ID })
    const reads = boat.calls.filter((call) => call.method === "GET").map((call) => call.at)
    expect(reads).toEqual([0, 250, 750, 1_750, 3_750, 5_750, 7_750])
    expect(boat.calls.find((call) => call.path.endsWith("/resume"))?.at).toBe(7_750)
  })

  test("the runtime's health is probed inside the machine every 100 ms, one Boat command per 50 s window", async () => {
    const boat = clockedBoat({ readyAt: 0 })
    const booted = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: boat.fetchImpl }).ensureHost(ensureInput())
    await settled(booted)
    const probes = boat.calls.filter((call) => call.command?.includes("/global/health"))
    expect(probes).toHaveLength(1)
    expect(probes[0]?.timeoutSeconds).toBe(60)
    expect(probes[0]?.command).toContain("end=$(($(date +%s) + 50))")
    expect(probes[0]?.command).toContain("sleep 0.1; done")
  })
})
