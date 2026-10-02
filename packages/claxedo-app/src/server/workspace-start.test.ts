/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { WorkspaceStartProgress } from "./cloud-types"
import { ServerError } from "./errors"
import { startWorkspace } from "./workspace-start"
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
  return { connect: createWorkspaceConnections(request).start, calls }
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

test("workspace start: a refusal with no retry hint fails at once with the server's reason", async () => {
  const server = answers(json({ error: { code: "billing_entitlement_required", message: "An active subscription is required" } }, 402))

  const start = startWorkspace(server.connect, "ws_1", { wait: async () => undefined })

  await expect(start).rejects.toBeInstanceOf(ServerError)
  await expect(start).rejects.toMatchObject({ code: "billing_entitlement_required", message: "An active subscription is required" })
  expect(server.calls).toHaveLength(1)
})

test("workspace start: gives up after thirty provisioning answers, and says it is still starting", async () => {
  const server = answers(...Array.from({ length: 31 }, () => json({ status: "provisioning", workspaceId: "ws_1", retryAfterMs: 2_000 })))

  await expect(startWorkspace(server.connect, "ws_1", { wait: async () => undefined })).rejects.toMatchObject({ class: "network", code: "workspace_still_starting" })
  expect(server.calls).toHaveLength(30)
})
