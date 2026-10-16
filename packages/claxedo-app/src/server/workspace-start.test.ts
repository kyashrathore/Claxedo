/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { WorkspaceStartProgress } from "./cloud-types"
import { ServerError } from "./errors"
import { followWorkspaceStart, startWorkspace } from "./workspace-start"
import { createWorkspaceConnections } from "./transport"
import { workspaceStopped } from "./wire/connection"

const READY = { relayUrl: "https://relay.test/", runtimeAccessToken: "rat", tokenExpiresAt: 1_900_000_000_000 }

function answers(...responses: readonly Response[]) {
  const calls: { path: string; method: string | undefined; body?: string }[] = []
  let next = 0
  const request = async (path: string, init?: RequestInit) => {
    calls.push({ path, method: init?.method, ...(typeof init?.body === "string" ? { body: init.body } : {}) })
    const response = responses[next++]
    if (!response) throw new Error("no answer left")
    return response
  }
  const connections = createWorkspaceConnections(request)
  return { connect: connections.start, read: (workspaceId: string) => connections.read(workspaceId), calls }
}

const json = (body: unknown, status = 200) => Response.json(body, { status })

test("workspace start: asks the explicit connect once as the person's retry, polls it while it provisions, each wait the server's own, and adopts the ready link", async () => {
  const server = answers(
    json({ status: "provisioning", workspaceId: "ws_1", retryAfterMs: 1_500, bootMode: "resume" }),
    json({ status: "provisioning", workspaceId: "ws_1", retryAfterMs: 20 }),
    json({ status: "provisioning", workspaceId: "ws_1", retryAfterMs: 90_000 }),
    json(READY),
  )
  const waits: number[] = []
  const progress: WorkspaceStartProgress[] = []
  const link = await startWorkspace(server.connect, "ws_1", { onProgress: (step) => progress.push(step), wait: async (ms) => void waits.push(ms) })

  expect(link).toEqual({ workspaceId: "ws_1", relayUrl: "https://relay.test", runtimeAccessToken: "rat", tokenExpiresAt: READY.tokenExpiresAt })
  const connect = { path: "/api/workspace/ws_1/connection", method: "POST" }
  expect(server.calls).toEqual([{ ...connect, body: '{"retry":true}' }, ...Array(3).fill({ ...connect, body: "{}" })])
  expect(waits).toEqual([1_500, 500, 30_000])
  expect(progress).toEqual([{ kind: "provisioning", bootMode: "resume" }, { kind: "provisioning" }, { kind: "provisioning" }])
})

test("workspace start: a start the server retries after a failed step reports that failure and when the retry runs, until a step succeeds", async () => {
  const server = answers(
    json({ status: "provisioning", workspaceId: "ws_1", retryAfterMs: 2_000, bootMode: "resume", failure: "Boat bx_1 runtime image preparation failed (exit 1): no space left on device" }),
    json({ status: "provisioning", workspaceId: "ws_1", retryAfterMs: 15_000, failure: "quota exceeded" }),
    json({ status: "provisioning", workspaceId: "ws_1", retryAfterMs: 2_000, bootMode: "resume" }),
    json(READY),
  )
  const progress: WorkspaceStartProgress[] = []

  await startWorkspace(server.connect, "ws_1", { onProgress: (step) => progress.push(step), wait: async () => undefined, now: () => 1_000_000 })

  expect(progress).toEqual([
    { kind: "provisioning", bootMode: "resume", failure: "Boat bx_1 runtime image preparation failed (exit 1): no space left on device", retryAt: 1_002_000 },
    { kind: "provisioning", failure: "quota exceeded", retryAt: 1_015_000 },
    { kind: "provisioning", bootMode: "resume" },
  ])
})

test("workspace start: a refusal with no retry hint fails at once with the server's reason", async () => {
  const server = answers(json({ error: { code: "billing_entitlement_required", message: "An active subscription is required" } }, 402))

  const start = startWorkspace(server.connect, "ws_1", { wait: async () => undefined })

  await expect(start).rejects.toBeInstanceOf(ServerError)
  await expect(start).rejects.toMatchObject({ code: "billing_entitlement_required", message: "An active subscription is required" })
  expect(server.calls).toHaveLength(1)
})

test("workspace start: a read that says the checkpoint cannot be restored ends the start under the code Start fresh is offered for", async () => {
  const line = "This workspace's saved files expired after 30 days unused; choose Start fresh."
  const server = answers(json({ status: "failed", workspaceId: "ws_1", error: line, checkpointUnusable: "expired" }))
  await expect(startWorkspace(server.connect, "ws_1", { wait: async () => undefined })).rejects.toMatchObject({ class: "conflict", code: "workspace_checkpoint_unusable", message: line })
})

test("workspace start: a read that says the boot failed ends the start with that reason, under the boot-failure code", async () => {
  const server = answers(json({ status: "failed", workspaceId: "ws_1", error: 'The branch "missing" does not exist in https://github.com/acme/widgets.git' }))

  const start = startWorkspace(server.connect, "ws_1", { wait: async () => undefined })

  await expect(start).rejects.toMatchObject({
    class: "conflict",
    code: "cloud_runtime_boot_failed",
    message: 'The branch "missing" does not exist in https://github.com/acme/widgets.git',
  })
  expect(server.calls).toHaveLength(1)
})

test("workspace start: follows the server's start for as long as it reports progress, with no poll budget of its own", async () => {
  const server = answers(...Array.from({ length: 200 }, () => json({ status: "provisioning", workspaceId: "ws_1", retryAfterMs: 2_000, bootMode: "resume" })), json(READY))

  const link = await startWorkspace(server.connect, "ws_1", { wait: async () => undefined })

  expect(link.runtimeAccessToken).toBe("rat")
  expect(server.calls).toHaveLength(201)
})

test("workspace start: ends when the server ends the start it was following, with the server's reason", async () => {
  const server = answers(
    json({ status: "provisioning", workspaceId: "ws_1", retryAfterMs: 2_000 }),
    json({ error: { code: "cloud_runtime_unavailable", message: "Cloud runtime is unavailable" } }, 409),
  )

  await expect(startWorkspace(server.connect, "ws_1", { wait: async () => undefined })).rejects.toMatchObject({ code: "cloud_runtime_unavailable", message: "Cloud runtime is unavailable" })
  expect(server.calls).toHaveLength(2)
})

test("following a start somebody else began reads the connection, never starts one, and adopts the link the server mints once it is ready", async () => {
  const server = answers(
    json({ status: "provisioning", workspaceId: "ws_1", retryAfterMs: 1_500, bootMode: "cold-start" }),
    json({ status: "provisioning", workspaceId: "ws_1" }),
    json(READY),
  )
  const waits: number[] = []
  const progress: WorkspaceStartProgress[] = []

  const link = await followWorkspaceStart(server.read, "ws_1", { onProgress: (step) => progress.push(step), wait: async (ms) => void waits.push(ms) })

  expect(link?.runtimeAccessToken).toBe("rat")
  expect(server.calls).toEqual(Array(3).fill({ path: "/api/workspace/ws_1/connection", method: undefined }))
  expect(waits).toEqual([1_500, 2_000])
  expect(progress).toEqual([{ kind: "provisioning", bootMode: "cold-start" }, { kind: "provisioning" }])
})

test("following a start ends with no link when the server says the workspace stopped or its boot failed", async () => {
  const stopped = answers(json({ status: "provisioning", workspaceId: "ws_1" }), json({ status: "stopped", workspaceId: "ws_1" }))
  expect(await followWorkspaceStart(stopped.read, "ws_1", { wait: async () => undefined })).toBeUndefined()
  expect(stopped.calls).toHaveLength(2)

  const failed = answers(json({ status: "failed", workspaceId: "ws_1", error: "no such branch" }))
  expect(await followWorkspaceStart(failed.read, "ws_1", { wait: async () => undefined })).toBeUndefined()
})

test("workspace start: the steps the server has recorded become the start's progress, timed from the server's own elapsed times on this clock", async () => {
  const server = answers(
    json({ status: "provisioning", workspaceId: "ws_1", retryAfterMs: 2_000, bootMode: "resume", progress: { phases: ["lease_decision"], sinceStartMs: 12_000, sinceStepMs: 11_900 } }),
    json({ status: "provisioning", workspaceId: "ws_1", retryAfterMs: 2_000, progress: { phases: ["lease_decision", "provider_ready", "image_ready", "repository_checkout"], sinceStartMs: 80_000, sinceStepMs: 3_000 } }),
    json({ status: "provisioning", workspaceId: "ws_1", retryAfterMs: 2_000, progress: { phases: ["warp"], sinceStartMs: "soon" } }),
    json(READY),
  )
  const progress: WorkspaceStartProgress[] = []
  let now = 1_000_000
  await startWorkspace(server.connect, "ws_1", { onProgress: (step) => progress.push(step), wait: async (ms) => void (now += ms), now: () => now })

  expect(progress).toEqual([
    { kind: "provisioning", bootMode: "resume", steps: { done: [], startedAt: 1_000_000 - 12_000, stepStartedAt: 1_000_000 - 11_900 } },
    { kind: "provisioning", steps: { done: ["machine", "image"], startedAt: 1_002_000 - 80_000, stepStartedAt: 1_002_000 - 3_000 } },
    { kind: "provisioning" },
  ])
})

test("workspace start: the machine is done once the provider says it takes commands, not when it only accepted the create", async () => {
  const answer = (phases: readonly string[]) => json({ status: "provisioning", workspaceId: "ws_1", retryAfterMs: 2_000, progress: { phases, sinceStartMs: 5_000, sinceStepMs: 1_000 } })
  const server = answers(answer(["lease_decision", "provider_ready"]), answer(["lease_decision", "provider_ready", "machine_ready"]), answer(["lease_decision", "machine_ready", "image_ready"]), json(READY))
  const done: (readonly string[] | undefined)[] = []
  await startWorkspace(server.connect, "ws_1", { onProgress: (step) => done.push(step.steps?.done), wait: async () => undefined })
  expect(done).toEqual([[], ["machine"], ["machine", "image"]])
})

function pending() {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const never = () => new Promise<never>(() => undefined)

test("workspace start: a poll the server never answers is asked again once its deadline passes, and the start goes on to ready", async () => {
  const answered = [json({ status: "provisioning", workspaceId: "ws_1", retryAfterMs: 2_000 }), undefined, json(READY)]
  let calls = 0
  const connections = createWorkspaceConnections(async () => answered[calls++] ?? never())

  const link = await startWorkspace(connections.start, "ws_1", { wait: async () => undefined, pollDeadlineMs: 5 })

  expect(link.runtimeAccessToken).toBe("rat")
  expect(calls).toBe(3)
})

function startNotices() {
  const listeners = new Set<() => void>()
  const settled = (listener: () => void) => {
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }
  return { listeners, settled, announce: () => [...listeners].forEach((listener) => listener()) }
}

test("workspace start: the server's notice that the start settled ends the wait at once, and the next poll adopts the ready link", async () => {
  const { listeners, settled, announce } = startNotices()
  const polled = pending()
  const answered = [json({ status: "provisioning", workspaceId: "ws_1", retryAfterMs: 2_000 }), json(READY)]
  let calls = 0
  const connections = createWorkspaceConnections(async () => {
    const index = calls++
    if (index === 0) polled.resolve()
    return answered[index] ?? never()
  })

  const start = startWorkspace(connections.start, "ws_1", { wait: never, settled })
  await polled.promise
  await Bun.sleep(0)
  announce()

  expect((await start).runtimeAccessToken).toBe("rat")
  expect(calls).toBe(2)
  expect(listeners.size).toBe(0)
})

test("workspace start: notices that the start settled while a poll is in flight send no second connect, and the next poll goes at once after that poll's answer", async () => {
  const { listeners, settled, announce } = startNotices()
  const inFlight = Promise.withResolvers<Response>()
  const answered = [Promise.resolve(json({ status: "provisioning", workspaceId: "ws_1", retryAfterMs: 2_000 })), inFlight.promise, Promise.resolve(json(READY))]
  const bodies: (string | undefined)[] = []
  const connections = createWorkspaceConnections(async (_path, init) => {
    const index = bodies.push(typeof init?.body === "string" ? init.body : undefined) - 1
    return answered[index] ?? never()
  })

  const start = startWorkspace(connections.start, "ws_1", { wait: never, settled })
  await Bun.sleep(0)
  announce()
  await Bun.sleep(0)
  announce()
  announce()
  await Bun.sleep(0)
  expect(bodies).toHaveLength(2)

  inFlight.resolve(json({ status: "provisioning", workspaceId: "ws_1", retryAfterMs: 2_000 }))
  expect((await start).runtimeAccessToken).toBe("rat")
  expect(bodies).toEqual(['{"retry":true}', "{}", "{}"])
  expect(listeners.size).toBe(0)
})

test("workspace start: a 409 refusal that names a wait ends the start at once with the server's reason and the wait, since nothing retries it before then", async () => {
  const reason = "Boat POST /sandboxes was rejected (rate_limited)"
  const server = answers(json({ error: { code: "cloud_runtime_unavailable", message: reason, retryAfterMs: 484_180, failure: reason } }, 409))

  const start = startWorkspace(server.connect, "ws_1", { wait: async () => undefined })

  await expect(start).rejects.toBeInstanceOf(ServerError)
  await expect(start).rejects.toMatchObject({ code: "cloud_runtime_unavailable", message: reason, details: { retryAfterMs: 484_180 } })
  expect(server.calls).toHaveLength(1)
})

test("workspace start: a server that answers the start stopped ends it in one line naming no workspace id, and a stopped workspace's read refusal names none either", async () => {
  const stopped = answers(json({ status: "stopped", workspaceId: "ws_1" }))
  await expect(startWorkspace(stopped.connect, "ws_1", { wait: async () => undefined })).rejects.toMatchObject({ message: "The workspace stopped while it was starting" })
  expect(workspaceStopped().message).toBe("The cloud workspace is not running")
})

test("workspace start: a 409 refusal with no wait ends the start with the server's plain reason, as a provider's daily start limit does", async () => {
  const reason = "Boat's daily start limit (200) is used up; try again later."
  const server = answers(json({ error: { code: "cloud_runtime_unavailable", message: reason, failure: reason } }, 409))
  await expect(startWorkspace(server.connect, "ws_1", { wait: async () => undefined })).rejects.toMatchObject({ code: "cloud_runtime_unavailable", message: reason })
  expect(server.calls).toHaveLength(1)
})
