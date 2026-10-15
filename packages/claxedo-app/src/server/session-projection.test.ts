/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createHostedAccount } from "./account"
import { placementId, projectId, sessionId } from "./ids"
import { createSessionProjection } from "./session-projection"
import type { Placement } from "./types"
import type { Workspaces } from "./workspaces"

function fixture(kind: Placement["kind"], signed: boolean, sessionHost?: { sessionId: string }, answer: (operation: string) => unknown = () => ({})) {
  const runs: { operation: string; input: unknown }[] = []
  const account = createHostedAccount(async (operation, input) => (runs.push({ operation, input }), answer(operation)))
  const placement = { id: placementId("ws_1"), projectId: projectId("proj"), kind, label: "main", reachable: true, onThisMachine: false }
  const route = { directory: "workspace:ws_1", workspaceId: "ws_1", remote: true, ...(sessionHost ? { sessionHost } : {}) }
  const workspaces = {
    byId: () => placement,
    locate: async () => route,
    home: async () => ({ route, central: !sessionHost, live: true }),
  } as Pick<Workspaces, "byId" | "locate" | "home"> as Workspaces
  return { runs, projection: createSessionProjection(workspaces, signed ? account : undefined) }
}

const ref = { projectId: projectId("proj"), placementId: placementId("ws_1"), sessionId: sessionId("ses_1") }

async function settle() {
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve()
}

const turnEnd = (completedAt: number) => ({ type: "statusChanged" as const, ref, status: { kind: "idle" as const }, lastTurn: { status: "completed" as const, completedAt } })

test("session projection: a signed cloud session is registered through the account, and each turn end asks it for a checkpoint", async () => {
  const { runs, projection } = fixture("cloud", true)

  await projection.created(ref)
  projection.observe({ type: "statusChanged", ref, status: { kind: "working" } })
  projection.observe(turnEnd(1_000))
  await settle()

  expect(runs.map((run) => run.operation)).toEqual(["session.projection.register", "session.projection.checkpoint"])
  expect(runs[1]?.input).toMatchObject({ workspaceId: "ws_1", sessionId: "ses_1", reason: "message-checkpoint" })
})

test("session projection: a turn end's checkpoint is keyed by the turn the runtime ended, so every tab that hears it asks for the same one, and an idle status that ends no turn asks for none", async () => {
  const tabs = [fixture("cloud", true), fixture("cloud", true)]

  for (const { projection } of tabs) {
    projection.observe({ type: "statusChanged", ref, status: { kind: "idle" } })
    projection.observe(turnEnd(1_000))
    projection.observe({ type: "statusChanged", ref, status: { kind: "failed", error: { class: "internal", message: "boom", retryable: false } }, lastTurn: { status: "failed", completedAt: 2_000 } })
  }
  await settle()

  const keys = tabs.map(({ runs }) => runs.map((run) => (run.input as { idempotencyKey: string }).idempotencyKey))
  expect(keys[0]).toEqual(["message-checkpoint:ses_1:1000", "message-checkpoint:ses_1:2000"])
  expect(keys[1]).toEqual(keys[0])
})

test("session projection: a checkpoint another client is already storing for the same turn end is theirs, not a failure", async () => {
  const warned: unknown[][] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => void warned.push(args)
  try {
    const inFlight = fixture("cloud", true, undefined, () => {
      throw new Error('HOSTED_HTTP 409 {"body":{"error":{"code":"control_plane_idempotency_in_flight","message":"Idempotency key is already being processed"}}}')
    })
    inFlight.projection.observe(turnEnd(1_000))
    await settle()
    expect(inFlight.runs).toHaveLength(1)
    expect(warned).toEqual([])

    const refused = fixture("cloud", true, undefined, () => {
      throw new Error('HOSTED_HTTP 503 {"body":{"error":{"code":"workspace_runtime_unavailable","message":"Workspace runtime pull transport is not configured"}}}')
    })
    refused.projection.observe(turnEnd(1_000))
    await settle()
    expect(warned).toHaveLength(1)
  } finally {
    console.warn = warn
  }
})

test("session projection: a folder's session, or one with no account, is never pulled", async () => {
  for (const { runs, projection } of [fixture("folder", true), fixture("cloud", false)]) {
    await projection.created(ref)
    projection.observe(turnEnd(1_000))
    await settle()
    expect(runs).toEqual([])
  }
})

test("session projection: a session served by its own host keeps its transcript there, so each turn end pulls its row again, never a checkpoint", async () => {
  const { runs, projection } = fixture("cloud", true, { sessionId: "ses_1" })

  await projection.created(ref)
  projection.observe(turnEnd(1_000))
  await settle()

  expect(runs.map((run) => run.operation)).toEqual(["session.projection.register", "session.projection.register"])
  expect(runs[1]?.input).toMatchObject({ workspaceId: "ws_1", sessionId: "ses_1", reason: "message-checkpoint" })
})
