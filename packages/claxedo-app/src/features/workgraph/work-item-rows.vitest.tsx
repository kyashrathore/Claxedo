import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import type { CommandResult, WorkItemDto } from "@claxedo/workgraph/contracts"
import type { WorkGraphClient } from "./api"
import { InlineAddTask, WorkItemLeaf, type Mutate } from "./work-item-rows"

const captured: Array<{ event: string; properties: Record<string, unknown> }> = []

vi.mock("@/platform/telemetry/analytics", () => ({
  capture: (event: string, properties: Record<string, unknown>) => {
    captured.push({ event, properties })
  },
  identityProps: () => ({ org_id: "org_1", user_id: "user_1", deployment_mode: "self-host" }),
}))

// A real (non-stubbed) `Mutate`: runs the action and reports its `ok` flag,
// mirroring `workgraph-content.tsx`'s implementation minus the refetch/toast
// side effects those tests don't need.
const mutate: Mutate = async (action) => {
  const result = await action()
  return result.ok
}

const provenance = { actor: { type: "user" as const, id: "user_1" } }
const completionContract = {
  version: 1 as const,
  mode: "all" as const,
  requirements: [{ id: "requirement_1", kind: "owner_confirmation" as const, description: "Confirm it is complete" }],
}

const stagedItem: WorkItemDto = {
  recordType: "work_item",
  schemaVersion: 1,
  ownerUserId: "user_1",
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  provenance,
  id: "item_staged_1",
  streamId: "stream_1",
  outcomeId: "outcome_1",
  title: "Draft the migration",
  state: "pending_approval",
  priority: 0,
  dependencyIds: [],
  sourceRevisionRefs: [],
  completionContract,
  evidenceIds: [],
  createdByActorType: "agent",
}

const stagedItemNoOutcome: WorkItemDto = { ...stagedItem, id: "item_staged_2", outcomeId: undefined }

function buildClient(): WorkGraphClient {
  return {
    createWorkItem: async (): Promise<CommandResult> => ({
      ok: true,
      operationId: "op_create",
      cursor: "cursor_1",
      value: { workItemId: "item_new_1" },
    }),
    approveWorkItem: async (): Promise<CommandResult> => ({
      ok: true,
      operationId: "op_approve",
      cursor: "cursor_2",
      value: {},
    }),
    // Only the two methods these components call are implemented; everything
    // else on the real WorkGraphClient is unused by InlineAddTask/WorkItemLeaf.
    // as-any: test double implements only the API surface exercised by this test.
  } as unknown as WorkGraphClient
}

afterEach(() => {
  cleanup()
  captured.length = 0
})

describe("InlineAddTask — workgraph_task_created telemetry", () => {
  test("submitting a title captures workgraph_task_created with an id-only property allowlist", async () => {
    const client = buildClient()
    render(() => (
      <InlineAddTask streamId="stream_1" outcomeId="outcome_1" scopeLabel="Ship Claxedo cloud" client={client} mutate={mutate} />
    ))

    await fireEvent.click(screen.getByRole("button", { name: "Add task" }))
    const input = screen.getByRole("textbox", { name: "Add task to Ship Claxedo cloud" })
    await fireEvent.input(input, { target: { value: "Ship the docs" } })
    await fireEvent.keyDown(input, { key: "Enter" })

    await waitFor(() => expect(captured.find((entry) => entry.event === "workgraph_task_created")).toBeDefined())
    const event = captured.find((entry) => entry.event === "workgraph_task_created")!

    expect(event.properties.task_id).toBe("item_new_1")
    expect(event.properties.stream_id).toBe("stream_1")
    expect(event.properties.outcome_id).toBe("outcome_1")
    // The guard against future PII creep: this enumerates the exact allowed
    // keys. Tripwire — add a forbidden property (e.g. `title`) at the call
    // site in work-item-rows.tsx's `InlineAddTask.submit`, watch this fail,
    // then remove it.
    expect(Object.keys(event.properties).sort()).toEqual(
      ["deployment_mode", "org_id", "outcome_id", "stream_id", "surface", "task_id", "user_id"].sort(),
    )
    // Never the title just typed, or any fragment of it.
    expect(Object.values(event.properties)).not.toContain("Ship the docs")
  })

  test("omits outcome_id entirely for a stream-level task (no synthesized empty value)", async () => {
    const client = buildClient()
    render(() => <InlineAddTask streamId="stream_1" scopeLabel="Ship Claxedo cloud" client={client} mutate={mutate} />)

    await fireEvent.click(screen.getByRole("button", { name: "Add task" }))
    const input = screen.getByRole("textbox", { name: "Add task to Ship Claxedo cloud" })
    await fireEvent.input(input, { target: { value: "Ship the docs" } })
    await fireEvent.keyDown(input, { key: "Enter" })

    await waitFor(() => expect(captured.find((entry) => entry.event === "workgraph_task_created")).toBeDefined())
    const event = captured.find((entry) => entry.event === "workgraph_task_created")!

    expect("outcome_id" in event.properties).toBe(false)
    expect(Object.keys(event.properties).sort()).toEqual(
      ["deployment_mode", "org_id", "stream_id", "surface", "task_id", "user_id"].sort(),
    )
  })
})

describe("WorkItemLeaf — workgraph_task_completed telemetry", () => {
  // `workgraph_task_completed` fires on the row's Approve action (admitting a
  // Staged task to run), not on the engine's own `state === "completed"`
  // transition — that is server/engine-driven with no client action to bind to.
  // See the W6 report for the full semantics.
  test("approving a staged task captures workgraph_task_completed with an id-only property allowlist", async () => {
    const client = buildClient()
    render(() => <WorkItemLeaf item={stagedItem} attempts={[]} client={client} mutate={mutate} onOpenTask={() => undefined} />)

    await fireEvent.click(screen.getByRole("button", { name: `Approve task ${stagedItem.title}` }))

    await waitFor(() => expect(captured.find((entry) => entry.event === "workgraph_task_completed")).toBeDefined())
    const event = captured.find((entry) => entry.event === "workgraph_task_completed")!

    expect(event.properties.task_id).toBe(stagedItem.id)
    expect(event.properties.stream_id).toBe(stagedItem.streamId)
    expect(event.properties.outcome_id).toBe(stagedItem.outcomeId)
    // The guard against future PII creep: this enumerates the exact allowed
    // keys. Tripwire — add a forbidden property (e.g. `title`) at the call
    // site in work-item-rows.tsx's `WorkItemLeaf.approve`, watch this fail,
    // then remove it.
    expect(Object.keys(event.properties).sort()).toEqual(
      ["deployment_mode", "org_id", "outcome_id", "stream_id", "surface", "task_id", "user_id"].sort(),
    )
    // Never the task's title.
    expect(Object.values(event.properties)).not.toContain(stagedItem.title)
  })

  test("omits outcome_id for a task with no outcome", async () => {
    const client = buildClient()
    render(() => (
      <WorkItemLeaf item={stagedItemNoOutcome} attempts={[]} client={client} mutate={mutate} onOpenTask={() => undefined} />
    ))

    await fireEvent.click(screen.getByRole("button", { name: `Approve task ${stagedItemNoOutcome.title}` }))

    await waitFor(() => expect(captured.find((entry) => entry.event === "workgraph_task_completed")).toBeDefined())
    const event = captured.find((entry) => entry.event === "workgraph_task_completed")!

    expect("outcome_id" in event.properties).toBe(false)
  })
})
