/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { WorkspaceStartProgress } from "./cloud-types"
import { ServerError } from "./errors"
import { followWorkspaceStart, startWorkspace } from "./workspace-start"
import { createWorkspaceConnections } from "./transport"

const READY = { relayUrl: "https://relay.test/", runtimeAccessToken: "rat", tokenExpiresAt: 1_900_000_000_000 }

function answers(...responses: readonly Response[]) {
  const calls: { path: string; method: string | undefined }[] = []
  let next = 0
  const request = async (path: string, init?: RequestInit) => {
    calls.push({ path, method: init?.method })
    const response = responses[next++]
    if (!response) throw new Error("no answer left")
    return response
  }
  const connections = createWorkspaceConnections(request)
  return { connect: connections.start, read: (workspaceId: string) => connections.read(workspaceId), calls }
}

const json = (body: unknown, status = 200) => Response.json(body, { status })

test("workspace start: polls the explicit connect while it provisions, each wait the server's own, and adopts the ready link", async () => {
  const server = answers(
    json({ status: "provisioning", workspaceId: "ws_1", retryAfterMs: 1_500, bootMode: "resume" }),
    json({ error: { code: "cloud_runtime_unavailable", message: "Cloud runtime is unavailable", retryAfterMs: 20 } }, 409),
    json({ status: "provisioning", workspaceId: "ws_1", retryAfterMs: 90_000 }),
    json(READY),
  )
  const waits: number[] = []
  const progress: WorkspaceStartProgress[] = []
  const link = await startWorkspace(server.connect, "ws_1", { onProgress: (step) => progress.push(step), wait: async (ms) => void waits.push(ms) })

  expect(link).toEqual({ workspaceId: "ws_1", relayUrl: "https://relay.test", runtimeAccessToken: "rat", tokenExpiresAt: READY.tokenExpiresAt })
  expect(server.calls).toEqual(Array(4).fill({ path: "/api/workspace/ws_1/connection", method: "POST" }))
  expect(waits).toEqual([1_500, 500, 30_000])
  expect(progress).toEqual([{ kind: "provisioning", bootMode: "resume" }, { kind: "provisioning" }, { kind: "provisioning" }])
})

test("workspace start: a start the server retries after a failed step reports that failure with its progress until a step succeeds", async () => {
  const server = answers(
    json({ status: "provisioning", workspaceId: "ws_1", retryAfterMs: 2_000, bootMode: "resume", failure: "Boat bx_1 runtime image preparation failed (exit 1): no space left on device" }),
    json({ error: { code: "cloud_runtime_unavailable", message: "quota exceeded", retryAfterMs: 15_000, failure: "quota exceeded" } }, 409),
    json({ status: "provisioning", workspaceId: "ws_1", retryAfterMs: 2_000, bootMode: "resume" }),
    json(READY),
  )
  const progress: WorkspaceStartProgress[] = []

  await startWorkspace(server.connect, "ws_1", { onProgress: (step) => progress.push(step), wait: async () => undefined })

  expect(progress).toEqual([
    { kind: "provisioning", bootMode: "resume", failure: "Boat bx_1 runtime image preparation failed (exit 1): no space left on device" },
    { kind: "provisioning", failure: "quota exceeded" },
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

test("workspace start: a read that says the boot failed ends the start with that reason, under the boot-failure code", async () => {
  const server = answers(json({ status: "failed", workspaceId: "ws_1", error: 'The cloud workspace could not start: The branch "missing" does not exist in https://github.com/acme/widgets.git' }))

  const start = startWorkspace(server.connect, "ws_1", { wait: async () => undefined })

  await expect(start).rejects.toMatchObject({
    class: "conflict",
    code: "cloud_runtime_boot_failed",
    message: 'The cloud workspace could not start: The branch "missing" does not exist in https://github.com/acme/widgets.git',
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

  const failed = answers(json({ status: "failed", workspaceId: "ws_1", error: "The cloud workspace could not start: no such branch" }))
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
