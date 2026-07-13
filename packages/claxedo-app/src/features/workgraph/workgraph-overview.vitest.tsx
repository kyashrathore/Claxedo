import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createComponent } from "solid-js"
import { describe, expect, test } from "vitest"
import { createWorkGraphClient } from "./api"
import { WorkGraphContent } from "./workgraph-content"

describe("WorkGraph overview actions", () => {
  test("deletes an eligible Stream and removes it from the overview", async () => {
    const commands: Array<Record<string, unknown>> = []
    let records: unknown[] = [stream]
    const request = workGraphRequest({
      records: () => records,
      command: (command) => {
        commands.push(command)
        records = []
        return success()
      },
    })

    render(() => createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }))
    await fireEvent.click(await screen.findByRole("button", { name: "Delete stream Ship Claxedo cloud" }))
    await fireEvent.click(screen.getByRole("button", { name: "Delete stream", exact: true }))

    await waitFor(() => expect(commands).toContainEqual({
      version: 1,
      type: "delete_stream",
      streamId: "stream_1",
      expectedVersion: 1,
      reason: "Deleted from overview",
    }))
    await waitFor(() => expect(screen.queryByText("Ship Claxedo cloud")).not.toBeInTheDocument())
    expect(screen.getByText("Create one for the first outcome you want to ship.")).toBeInTheDocument()
  })

  test("closes a Stream when durable effects make deletion ineligible", async () => {
    const commands: Array<Record<string, unknown>> = []
    let records: unknown[] = [stream]
    const request = workGraphRequest({
      records: () => records,
      command: (command) => {
        commands.push(command)
        if (command.type === "delete_stream") {
          return {
            ok: false,
            operationId: "operation_1",
            cursor: "cursor_1",
            error: { code: "close_required", message: "Durable effects require close", retryable: false },
          }
        }
        records = [{ ...stream, lifecycleState: "closed", version: 2 }]
        return success()
      },
    })

    render(() => createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }))
    await fireEvent.click(await screen.findByRole("button", { name: "Delete stream Ship Claxedo cloud" }))
    await fireEvent.click(screen.getByRole("button", { name: "Delete stream", exact: true }))

    await waitFor(() => expect(commands).toEqual([
      { version: 1, type: "delete_stream", streamId: "stream_1", expectedVersion: 1, reason: "Deleted from overview" },
      { version: 1, type: "close_stream", streamId: "stream_1", expectedVersion: 1, reason: "Deleted from overview" },
    ]))
    await waitFor(() => expect(screen.queryByRole("button", { name: "Delete stream", exact: true })).not.toBeInTheDocument())
    expect(screen.getByText("Ship Claxedo cloud")).toBeInTheDocument()
  })

  test("reports a rejected deletion and re-enables its confirmation action", async () => {
    const request = workGraphRequest({
      records: () => [stream],
      command: () => {
        throw new Error("connection refused")
      },
    })

    render(() => createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }))
    await fireEvent.click(await screen.findByRole("button", { name: "Delete stream Ship Claxedo cloud" }))
    const confirmation = screen.getByRole("button", { name: "Delete stream", exact: true })
    await fireEvent.click(confirmation)

    expect(await screen.findByRole("alert")).toHaveTextContent("WorkGraph is offline")
    await waitFor(() => expect(confirmation).toBeEnabled())
  })

  test("abandons an idle Work Item with the exact command and removes it from the overview", async () => {
    const commands: Array<Record<string, unknown>> = []
    let records: unknown[] = [stream, outcome, pendingItem]
    const request = workGraphRequest({
      records: () => records,
      command: (command) => {
        commands.push(command)
        records = [stream, outcome, {
          ...pendingItem,
          state: "abandoned",
          version: 2,
          abandonedAt: 2,
          abandonReason: "Deleted from overview",
        }]
        return success()
      },
    })

    render(() => createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }))
    await fireEvent.click(await screen.findByRole("button", { name: "Delete task Remove obsolete setup" }))

    await waitFor(() => expect(commands).toContainEqual({
      version: 1,
      type: "cancel_work_item",
      workItemId: "item_idle",
      expectedVersion: 1,
      reason: "Deleted from overview",
    }))
    await waitFor(() => expect(screen.queryByText("Remove obsolete setup")).not.toBeInTheDocument())
  })

  test("does not offer task abandonment while its Attempt is live", async () => {
    const request = workGraphRequest({ records: () => [stream, outcome, activeItem, runningAttempt], command: () => success() })

    render(() => createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }))

    expect(await screen.findByText("Deploy production")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Delete task Deploy production" })).not.toBeInTheDocument()
  })

  test("shows a Stream-owned recap marker only when a latest recap exists, opening a focus/hover preview", async () => {
    const request = workGraphRequest({ records: () => [streamWithRecap], command: () => success() })
    render(() => createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }))

    const chip = await screen.findByRole("button", { name: "Latest recap for Ship Claxedo cloud" })
    // Keyboard focus opens the accessible popover with the real recap preview —
    // summary and actionable reference count, never fabricated.
    fireEvent.focus(chip)
    expect(await screen.findByText("Shipped idempotency keys and cleaned up retries.")).toBeInTheDocument()
    expect(screen.getByText(/2 actionable refs/)).toBeInTheDocument()
  })

  test("renders no recap marker for a stream without a latest recap", async () => {
    const request = workGraphRequest({ records: () => [stream], command: () => success() })
    render(() => createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }))

    await screen.findByText("Ship Claxedo cloud")
    expect(screen.queryByRole("button", { name: /Latest recap for/ })).toBeNull()
  })

  test("names the inline Add task input for its Stream instead of leaving it placeholder-only", async () => {
    const request = workGraphRequest({ records: () => [stream], command: () => success() })
    render(() => createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }))

    await fireEvent.click(await screen.findByRole("button", { name: "Add task" }))
    const input = await screen.findByRole("textbox", { name: "Add task to Ship Claxedo cloud" })
    // The "Add task" affordance and its placeholder hint stay intact alongside the accessible name.
    expect(input).toHaveAttribute("placeholder", "Task title, then Enter")
  })

  test("scopes the inline Add task input name to its Outcome", async () => {
    const request = workGraphRequest({ records: () => [stream, outcome], command: () => success() })
    render(() => createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }))

    // Both an Outcome-level and a Stream-level "Add task" exist; the Outcome-level one precedes it in the tree.
    const adds = await screen.findAllByRole("button", { name: "Add task" })
    await fireEvent.click(adds[0])
    expect(await screen.findByRole("textbox", { name: "Add task to Claxedo cloud is live" })).toBeInTheDocument()
  })

  test("exposes the lazy recap popover with a stable accessible role and name", async () => {
    const request = workGraphRequest({ records: () => [streamWithRecap], command: () => success() })
    render(() => createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }))

    fireEvent.focus(await screen.findByRole("button", { name: "Latest recap for Ship Claxedo cloud" }))
    // Stable regardless of the loading/error/loaded content the popover shows inside.
    expect(await screen.findByRole("group", { name: "Latest recap" })).toBeInTheDocument()
  })
})

function workGraphRequest(input: {
  records: () => unknown[]
  command: (command: Record<string, unknown>) => Record<string, unknown>
}) {
  return async (request: string | URL | Request, init?: RequestInit) => {
    const pathname = new URL(typeof request === "string" ? request : request instanceof URL ? request : request.url).pathname
    if (pathname.endsWith("/changes")) return Response.json({ changes: [], cursor: "cursor_1", timedOut: false })
    if (pathname.includes("/attention")) return Response.json({ items: [], total: 0, hasMore: false })
    if (pathname.includes("/recaps/")) return Response.json(recap)
    if (pathname.endsWith("/notifications")) return Response.json({ notifications: [], hasMore: false })
    if (pathname.endsWith("/defaults")) return Response.json({
      recordType: "workgraph",
      schemaVersion: 1,
      ownerUserId: "user_1",
      version: 1,
      createdAt: 1,
      updatedAt: 1,
      provenance: { actor: { type: "user", id: "user_1" } },
      id: "workgraph_default",
      defaults: { execution: {}, recap: {} },
    })
    if (pathname.endsWith("/commands")) {
      const body = JSON.parse(String(init?.body)) as { command: Record<string, unknown> }
      return Response.json(input.command(body.command))
    }
    const records = input.records() as Array<{ recordType: string; id: string; version: number }>
    return Response.json({
      snapshotCursor: "cursor_1",
      records,
      references: records.map((record, index) => ({ sequence: index + 1, resource: { type: record.recordType, id: record.id }, version: record.version })),
      hasMore: false,
      capturedAt: 2,
    })
  }
}

function success() {
  return { ok: true, operationId: "operation_1", cursor: "cursor_2", value: {} }
}

const provenance = { actor: { type: "user" as const, id: "user_1" } }
const stream = {
  recordType: "stream" as const,
  schemaVersion: 1 as const,
  ownerUserId: "user_1",
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  provenance,
  id: "stream_1",
  title: "Ship Claxedo cloud",
  lifecycleState: "active" as const,
  visibility: "visible" as const,
  pinned: false,
  executionDefaults: {},
  recapDefaults: {},
  activity: { lastActivityAt: 1, recapDueAt: 2 },
  durableEffectCount: 0,
  sourceRevisionRefs: [],
}
const streamWithRecap = {
  ...stream,
  activity: { lastActivityAt: 1, recapDueAt: 2, lastRecapId: "recap_1" },
}
const recap = {
  recordType: "recap" as const,
  schemaVersion: 1 as const,
  ownerUserId: "user_1",
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  provenance,
  id: "recap_1",
  streamId: "stream_1",
  activityRange: { fromSequence: 1, toSequence: 5, quietSince: 10 },
  summary: "Shipped idempotency keys and cleaned up retries.",
  actionableReferences: [
    { type: "work_item", id: "item_1" },
    { type: "attempt", id: "attempt_1" },
  ],
  generation: {
    state: "succeeded",
    model: { providerId: "anthropic", modelId: "claude-sonnet-4-5" },
    effort: "high",
    generatedAt: 1,
    method: "agent_session",
    sessionId: "session_1",
  },
  sourceRevisionRefs: [],
}
const outcome = {
  recordType: "outcome" as const,
  schemaVersion: 1 as const,
  ownerUserId: "user_1",
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  provenance,
  id: "outcome_1",
  streamId: "stream_1",
  title: "Claxedo cloud is live",
  state: "active" as const,
  successCriteria: ["Production is healthy"],
  evidenceIds: [],
  sourceRevisionRefs: [],
}
const completionContract = {
  version: 1 as const,
  mode: "all" as const,
  requirements: [{
    id: "requirement_1",
    kind: "verification" as const,
    description: "Smoke test passes",
    instructions: "Run the smoke test",
  }],
}
const pendingItem = {
  recordType: "work_item" as const,
  schemaVersion: 1 as const,
  ownerUserId: "user_1",
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  provenance,
  id: "item_idle",
  streamId: "stream_1",
  outcomeId: "outcome_1",
  title: "Remove obsolete setup",
  state: "pending" as const,
  priority: 1,
  dependencyIds: [],
  sourceRevisionRefs: [],
  completionContract,
  evidenceIds: [],
}
const activeItem = { ...pendingItem, id: "item_active", title: "Deploy production", state: "active" as const }
const runningAttempt = {
  recordType: "attempt" as const,
  schemaVersion: 1 as const,
  ownerUserId: "user_1",
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  provenance,
  id: "attempt_1",
  streamId: "stream_1",
  workItemId: "item_active",
  attemptNumber: 1,
  state: "running" as const,
  resolvedExecution: {
    environment: { kind: "local_worktree" as const },
    harness: "claxedo-v2",
    agent: "build",
    model: { providerId: "openai", modelId: "gpt-5" },
    effort: "high",
    tools: [],
    connectionIds: [],
    isolation: "stream" as const,
    cleanup: "destroy_on_close" as const,
    integration: "pull_request" as const,
  },
  admittedAt: 1,
  startedAt: 1,
  sourceRevisionRefs: [],
}
