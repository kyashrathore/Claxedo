import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { createComponent, createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createWorkGraphClient } from "./api"
import { WorkGraphContent } from "./workgraph-content"
import { StreamTasksPanelBody } from "./stream-tasks-panel"
import { WorkGraphProjectGroups } from "./workgraph-overview"
import { taskStatusLabel } from "./work-item-rows"

// Persisted UI state (if any) lives in localStorage; reset it so each test
// starts from a first-visit default rather than a prior test's leftovers.
beforeEach(() => localStorage.clear())
afterEach(() => cleanup())

describe("WorkGraph overview actions", () => {
  test("opens an approved pending Task inspector as read-only — will run automatically, no Run button", async () => {
    const request = workGraphRequest({ records: () => [stream, outcome, pendingItem], command: () => success() })
    render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )

    await fireEvent.click(await screen.findByRole("button", { name: `Open task ${pendingItem.title}` }))
    // Launch is automatic: the inspector reports where the task stands and never
    // offers a Run button (the old execute_work_item path is deleted).
    expect(await screen.findByText("Ready — will run automatically")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Run task" })).toBeNull()
  })

  test("approves a staged Task from its row with the exact approve_work_item command", async () => {
    const commands: Array<Record<string, unknown>> = []
    const request = workGraphRequest({
      records: () => [stream, outcome, stagedItem],
      command: (command) => {
        commands.push(command)
        return success()
      },
    })
    render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )

    expect(await screen.findByText("Approve & run")).toBeInTheDocument()
    await fireEvent.click(await screen.findByRole("button", { name: `Approve task ${stagedItem.title}` }))
    await waitFor(() =>
      expect(commands).toContainEqual({ version: 1, type: "approve_work_item", workItemId: stagedItem.id, expectedVersion: 1 }),
    )
  })

  test("rejects a staged Task only after a required reason is supplied", async () => {
    const commands: Array<Record<string, unknown>> = []
    const request = workGraphRequest({
      records: () => [stream, outcome, stagedItem],
      command: (command) => {
        commands.push(command)
        return success()
      },
    })
    render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )

    await fireEvent.click(await screen.findByRole("button", { name: `Reject task ${stagedItem.title}` }))
    const reason = await screen.findByRole("textbox", { name: `Reject reason for ${stagedItem.title}` })
    await fireEvent.input(reason, { target: { value: "Duplicate of an existing task" } })
    await fireEvent.click(screen.getByRole("button", { name: `Confirm reject ${stagedItem.title}` }))

    await waitFor(() =>
      expect(commands).toContainEqual({
        version: 1,
        type: "reject_work_item",
        workItemId: stagedItem.id,
        expectedVersion: 1,
        reason: "Duplicate of an existing task",
      }),
    )
  })

  test("describes the Stream-owned execution target without inheritance language", async () => {
    const targeted = {
      ...stream,
      executionDefaults: {
        environment: { kind: "local_worktree" as const, directory: "/Users/me/claxedo" },
        repository: { baseRevision: "dev" },
      },
    }
    const request = workGraphRequest({ records: () => [targeted], command: () => success() })
    render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )

    // The target surfaces as the Project the Stream is grouped under (header +
    // full path) — never as inheritance language, and never as a card flag when
    // the target is present.
    expect(await screen.findByRole("region", { name: "Project claxedo" })).toBeInTheDocument()
    expect(screen.getByText("/Users/me/claxedo")).toBeInTheDocument()
    expect(screen.getByText("worktree · from dev")).toBeInTheDocument()
    expect(screen.queryByText(/inherit/i)).toBeNull()
    expect(screen.queryByText("Execution target required")).toBeNull()
  })

  test("marks legacy Streams without their own target as requiring configuration", async () => {
    const request = workGraphRequest({ records: () => [stream], command: () => success() })
    render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )

    expect(await screen.findByText("Execution target required")).toBeInTheDocument()
    expect(screen.queryByText(/inherit/i)).toBeNull()
  })

  test("shows the master's durable status and receipt count on the Stream card", async () => {
    const mastered = {
      ...stream,
      masterStatus: {
        state: "hibernating" as const,
        sessionId: "ses_master_stream_1",
        message: "Master is up to date",
        receiptRefs: ["file:diff.patch", "https://github.test/pull/1"],
        updatedAt: 2,
      },
    }
    const request = workGraphRequest({ records: () => [mastered], command: () => success() })
    render(() => createComponent(WorkGraphContent, {
      client: createWorkGraphClient({ baseUrl: "http://test.local", request }),
    }))

    expect((await screen.findByText("Master · up to date · 2 receipts")).closest(".workgraph-streamcard-master"))
      .toHaveAttribute("title", "Master is up to date")
    expect(screen.getByRole("link", { name: "Open master receipt https://github.test/pull/1" }))
      .toHaveAttribute("href", "https://github.test/pull/1")
  })

  test("shows a Notes link only for a Stream with a durable notes source", async () => {
    const open = vi.fn()
    const noted = {
      ...stream,
      notesSource: { workSourceId: "source_notes", revisionId: "revision_notes", contentHash: "a".repeat(64) },
    }
    render(() => (
      <WorkGraphProjectGroups
        streams={[noted]}
        outcomes={[]}
        items={[]}
        runs={[]}
        empty={<div>No streams</div>}
        relativeTime={() => "now"}
        client={createWorkGraphClient({ baseUrl: "http://test.local", request: workGraphRequest({ records: () => [noted], command: () => success() }) })}
        mutate={async () => true}
        onOpenStreamSettings={() => undefined}
        onOpenStreamNotes={open}
        onOpenStreamTasks={() => undefined}
        onOpenTask={() => undefined}
        onNewStream={() => undefined}
      />
    ))
    await fireEvent.click(screen.getByRole("button", { name: "Open notes for Ship Claxedo cloud" }))
    expect(open).toHaveBeenCalledWith(noted)
  })

  test("deletes a disposable Stream with delete_stream only and never closes it", async () => {
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

    render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )
    // durableEffectCount === 0 means the only lifecycle action offered is Delete.
    await fireEvent.click(await screen.findByRole("button", { name: "Delete stream Ship Claxedo cloud" }))
    expect(screen.getByText(/disposable planned work and environment are destroyed/)).toBeInTheDocument()
    await fireEvent.click(screen.getByRole("button", { name: "Delete stream", exact: true }))

    // Exactly one command — delete_stream — with no fallback to close_stream.
    await waitFor(() =>
      expect(commands).toEqual([
        {
          version: 1,
          type: "delete_stream",
          streamId: "stream_1",
          expectedVersion: 1,
          reason: "Deleted from overview",
        },
      ]),
    )
    expect(commands.some((command) => command.type === "close_stream")).toBe(false)
    await waitFor(() => expect(screen.queryByText("Ship Claxedo cloud")).not.toBeInTheDocument())
    expect(screen.getByText("Create one for the first outcome you want to ship.")).toBeInTheDocument()
  })

  test("closes a durable-effect Stream with close_stream only and never deletes it", async () => {
    const commands: Array<Record<string, unknown>> = []
    let records: unknown[] = [durableStream]
    const request = workGraphRequest({
      records: () => records,
      command: (command) => {
        commands.push(command)
        records = [{ ...durableStream, lifecycleState: "closed", version: 2 }]
        return success()
      },
    })

    render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )
    // durableEffectCount > 0 means the only lifecycle action offered is Close.
    await fireEvent.click(await screen.findByRole("button", { name: "Close stream Ship Claxedo cloud" }))
    expect(screen.getByText(/durable history is preserved and any unfinished work is abandoned/)).toBeInTheDocument()
    await fireEvent.click(screen.getByRole("button", { name: "Close stream", exact: true }))

    // Exactly one command — close_stream — with no fallback to delete_stream.
    await waitFor(() =>
      expect(commands).toEqual([
        { version: 1, type: "close_stream", streamId: "stream_1", expectedVersion: 1, reason: "Closed from overview" },
      ]),
    )
    expect(commands.some((command) => command.type === "delete_stream")).toBe(false)
    // Confirming closes the popover, and the record is preserved: the closed
    // Stream stays on the overview, still offering Close (never Delete).
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Close stream", exact: true })).not.toBeInTheDocument(),
    )
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Close stream Ship Claxedo cloud" })).toBeInTheDocument(),
    )
  })

  test("never auto-closes when a disposable delete race returns close_required", async () => {
    const commands: Array<Record<string, unknown>> = []
    const request = workGraphRequest({
      // durableEffectCount === 0 at render time, so the UI offers Delete only.
      records: () => [stream],
      command: (command) => {
        commands.push(command)
        return {
          ok: false,
          operationId: "operation_1",
          cursor: "cursor_1",
          error: { code: "close_required", message: "Durable effects require close", retryable: false },
        }
      },
    })

    render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )
    await fireEvent.click(await screen.findByRole("button", { name: "Delete stream Ship Claxedo cloud" }))
    await fireEvent.click(screen.getByRole("button", { name: "Delete stream", exact: true }))

    // The typed rejection surfaces instead of the UI silently issuing close_stream.
    expect(await screen.findByRole("alert")).toHaveTextContent("Durable effects require close")
    await waitFor(() =>
      expect(commands).toEqual([
        {
          version: 1,
          type: "delete_stream",
          streamId: "stream_1",
          expectedVersion: 1,
          reason: "Deleted from overview",
        },
      ]),
    )
    expect(commands.some((command) => command.type === "close_stream")).toBe(false)
    // The explicit Delete action stays put for a fresh, user-initiated run.
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete stream", exact: true })).toBeEnabled())
  })

  test("reports a rejected deletion and re-enables its confirmation action", async () => {
    const request = workGraphRequest({
      records: () => [stream],
      command: () => {
        throw new Error("connection refused")
      },
    })

    render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )
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
        records = [
          stream,
          outcome,
          {
            ...pendingItem,
            state: "abandoned",
            version: 2,
            abandonedAt: 2,
            abandonReason: "Deleted from overview",
          },
        ]
        return success()
      },
    })

    render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )
    await fireEvent.click(await screen.findByRole("button", { name: "Delete task Remove obsolete setup" }))

    await waitFor(() =>
      expect(commands).toContainEqual({
        version: 1,
        type: "cancel_work_item",
        workItemId: "item_idle",
        expectedVersion: 1,
        reason: "Deleted from overview",
      }),
    )
    await waitFor(() => expect(screen.queryByText("Remove obsolete setup")).not.toBeInTheDocument())
  })

  test("does not offer task abandonment while its Run is live", async () => {
    const request = workGraphRequest({
      records: () => [stream, outcome, activeItem, runningRun],
      command: () => success(),
    })

    render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )

    expect(await screen.findByText("Deploy production")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Delete task Deploy production" })).not.toBeInTheDocument()
  })

  test("retries an attention task directly from its row", async () => {
    const commands: Array<Record<string, unknown>> = []
    const request = workGraphRequest({
      records: () => [stream, outcome, activeItem, parkedRun],
      command: (command) => {
        commands.push(command)
        return success()
      },
    })

    render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )

    await fireEvent.click(await screen.findByRole("button", { name: "Retry task Deploy production" }))
    await waitFor(() =>
      expect(commands).toEqual([
        { version: 1, type: "retry_work_item", workItemId: "item_active", expectedVersion: 1 },
      ]),
    )
  })

  test("retries every attention task directly from its Stream row", async () => {
    const secondItem = { ...activeItem, id: "item_second", title: "Verify production", version: 3 }
    const secondRun = { ...parkedRun, id: "run_2", workItemId: secondItem.id }
    const commands: Array<Record<string, unknown>> = []
    const request = workGraphRequest({
      records: () => [stream, outcome, activeItem, secondItem, parkedRun, secondRun],
      command: (command) => {
        commands.push(command)
        return success()
      },
    })

    render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )

    await fireEvent.click(await screen.findByRole("button", { name: "Retry stream Ship Claxedo cloud" }))
    await waitFor(() =>
      expect(commands).toEqual([
        { version: 1, type: "retry_work_item", workItemId: "item_active", expectedVersion: 1 },
        { version: 1, type: "retry_work_item", workItemId: "item_second", expectedVersion: 3 },
      ]),
    )
  })

  test("opens the latest related Session from the snapshot without a click-time read", async () => {
    const onOpenSession = vi.fn()
    const earlierRun = { ...runningRun, state: "result" as const }
    const latestRun = {
      ...runningRun,
      id: "run_2",
      runNumber: 2,
      executionReferences: { sessionId: "session_running", workspaceId: "workspace_running" },
    }
    const runReads: string[] = []
    const request = workGraphRequest({
      records: () => [stream, outcome, activeItem, earlierRun, latestRun],
      command: () => success(),
      run: (runId) => {
        runReads.push(runId)
        return {
          run: latestRun,
          executionReferences: { sessionId: "session_running", workspaceId: "workspace_running" },
        }
      },
    })

    render(() =>
      createComponent(WorkGraphContent, {
        client: createWorkGraphClient({ baseUrl: "http://test.local", request }),
        onOpenSession,
      }),
    )

    await fireEvent.click(await screen.findByRole("button", { name: "Open session for Deploy production" }))
    await waitFor(() =>
      expect(onOpenSession).toHaveBeenCalledWith({
        sessionId: "session_running",
        workspaceId: "workspace_running",
        harness: latestRun.resolvedExecution.harness,
        environment: latestRun.resolvedExecution.environment,
      }),
    )
    expect(runReads).toEqual([])
  })

  test("stops a running Task from the shared row and renders Stopped · Retry after cancellation", async () => {
    const commands: Array<Record<string, unknown>> = []
    let records: unknown[] = [stream, outcome, activeItem, runningRun]
    const request = workGraphRequest({
      records: () => records,
      command: (command) => {
        commands.push(command)
        records = [
          stream,
          outcome,
          activeItem,
          { ...runningRun, state: "cancelled", version: 2, finishedAt: 2 },
        ]
        return success()
      },
    })
    render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )

    await fireEvent.click(await screen.findByRole("button", { name: "Stop task Deploy production" }))
    await waitFor(() => expect(commands).toEqual([{
      version: 1,
      type: "cancel_run",
      runId: "run_1",
      expectedVersion: 1,
      reason: "Stopped from task row",
    }]))
    expect(await screen.findByText("Stopped · Retry")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Retry task Deploy production" })).toBeInTheDocument()
  })





  test("names the inline Add task input for its Stream instead of leaving it placeholder-only", async () => {
    const request = workGraphRequest({ records: () => [stream], command: () => success() })
    render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )

    await fireEvent.click(await screen.findByRole("button", { name: "Add task" }))
    const input = await screen.findByRole("textbox", { name: "Add task to Ship Claxedo cloud" })
    // The "Add task" affordance and its placeholder hint stay intact alongside the accessible name.
    expect(input).toHaveAttribute("placeholder", "Task title, then Enter")
  })

  test("preserves an inline Task draft when a refreshed snapshot replaces Stream DTO objects", async () => {
    const [streams, setStreams] = createSignal([stream])
    const client = createWorkGraphClient({
      baseUrl: "http://test.local",
      request: workGraphRequest({ records: streams, command: () => success() }),
    })
    render(() => (
      <WorkGraphProjectGroups
        streams={streams()}
        outcomes={[]}
        items={[]}
        runs={[]}
        empty={<div>No streams</div>}
        relativeTime={() => "now"}
        client={client}
        mutate={async () => true}
        onOpenStreamSettings={() => undefined}
        onOpenStreamNotes={() => undefined}
        onOpenStreamTasks={() => undefined}
        onOpenTask={() => undefined}
        onNewStream={() => undefined}
      />
    ))

    await fireEvent.click(screen.getByRole("button", { name: "Add task" }))
    const input = screen.getByRole("textbox", { name: "Add task to Ship Claxedo cloud" })
    await fireEvent.input(input, { target: { value: "Keep this draft" } })
    setStreams([{ ...stream, version: 2, updatedAt: 2 }])

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Add task to Ship Claxedo cloud" })).toHaveValue("Keep this draft"))
    expect(screen.getByRole("textbox", { name: "Add task to Ship Claxedo cloud" })).toBe(input)
  })

  test("scopes the panel task list's inline Add task input name to its Outcome", async () => {
    // Outcome grouping lives in the panel's full task list; the Stream card only
    // previews a flat slice. Both an Outcome-level and a Stream-level "Add task"
    // exist there; the Outcome-level one precedes the Stream-level one.
    const client = createWorkGraphClient({
      baseUrl: "http://test.local",
      request: workGraphRequest({ records: () => [stream, outcome, pendingItem], command: () => success() }),
    })
    render(() => (
      <StreamTasksPanelBody
        stream={stream}
        outcomes={[outcome]}
        items={[pendingItem]}
        runs={[]}
        client={client}
        mutate={async () => true}
        onOpenTask={() => undefined}
      />
    ))

    const adds = await screen.findAllByRole("button", { name: "Add task" })
    await fireEvent.click(adds[0])
    expect(await screen.findByRole("textbox", { name: "Add task to Claxedo cloud is live" })).toBeInTheDocument()
  })

  test("pauses an active Stream with the exact set_stream_lifecycle command", async () => {
    const commands: Array<Record<string, unknown>> = []
    const request = workGraphRequest({
      records: () => [stream, outcome, pendingItem],
      command: (command) => {
        commands.push(command)
        return success()
      },
    })
    render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )

    // Pause is THE launch control now — no execute popover exists.
    expect(screen.queryByRole("button", { name: "Execute stream Ship Claxedo cloud" })).toBeNull()
    await fireEvent.click(await screen.findByRole("button", { name: "Pause stream Ship Claxedo cloud" }))
    await fireEvent.click(screen.getByRole("button", { name: "Pause stream", exact: true }))
    await waitFor(() =>
      expect(commands).toEqual([
        { version: 1, type: "set_stream_lifecycle", streamId: "stream_1", expectedVersion: 1, state: "paused", reason: "Paused from overview" },
      ]),
    )
  })

  test("can pause a Stream and stop its running work from the Pause popover", async () => {
    const commands: Array<Record<string, unknown>> = []
    const request = workGraphRequest({
      records: () => [stream, outcome, activeItem, runningRun],
      command: (command) => {
        commands.push(command)
        return success()
      },
    })
    render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )

    await fireEvent.click(await screen.findByRole("button", { name: "Pause stream Ship Claxedo cloud" }))
    await fireEvent.click(screen.getByRole("checkbox", { name: "Also stop running work" }))
    await fireEvent.click(screen.getByRole("button", { name: "Pause stream", exact: true }))
    await waitFor(() => expect(commands).toEqual([
      { version: 1, type: "set_stream_lifecycle", streamId: "stream_1", expectedVersion: 1, state: "paused", reason: "Paused from overview" },
      { version: 1, type: "cancel_run", runId: "run_1", expectedVersion: 1, reason: "Stopped while pausing Stream" },
    ]))
  })

  test("resumes a paused Stream with the exact set_stream_lifecycle command and marks it paused", async () => {
    const pausedStream = { ...stream, lifecycleState: "paused" as const }
    const commands: Array<Record<string, unknown>> = []
    const request = workGraphRequest({
      records: () => [pausedStream, outcome, pendingItem],
      command: (command) => {
        commands.push(command)
        return success()
      },
    })
    render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )

    // A paused Stream is load-bearing: the card names it and its approved ready
    // tasks read "Ready · paused" rather than "Queued".
    expect(await screen.findByText("Paused")).toBeInTheDocument()
    expect(screen.getByText("Ready · paused")).toHaveClass("workgraph-leaf-paused")
    await fireEvent.click(screen.getByRole("button", { name: "Resume stream Ship Claxedo cloud" }))
    await waitFor(() =>
      expect(commands).toEqual([
        { version: 1, type: "set_stream_lifecycle", streamId: "stream_1", expectedVersion: 1, state: "active", reason: "Resumed from overview" },
      ]),
    )
  })
})

describe("taskStatusLabel six-label truth table", () => {
  test.each([
    ["pending_approval", true, "staged"],
    ["pending_approval", false, "staged"],
    ["pending", false, "waiting"],
    ["pending", true, "ready"],
    ["active", true, "running"],
    ["result_ready", true, "needs-you"],
    ["review_needed", true, "needs-you"],
    ["integration_needed", true, "needs-you"],
    ["blocked", true, "needs-you"],
    ["verification_failed", true, "needs-you"],
    ["failed", true, "needs-you"],
    ["completed", true, "done"],
  ] as const)("%s with depsComplete=%s ⇒ %s", (state, depsComplete, expected) => {
    expect(taskStatusLabel(state, depsComplete)).toBe(expected)
  })
})

describe("WorkGraph project grouping", () => {
  const targeted = (directory: string) => ({
    environment: { kind: "local_worktree" as const, directory },
    repository: { baseRevision: "dev" },
  })
  const leadStream = { ...stream, id: "stream_1", title: "Ship Claxedo cloud", executionDefaults: targeted("/Users/me/claxedo"), activity: { lastActivityAt: 2 } }
  const secondStream = { ...stream, id: "stream_2", title: "Migrate billing", executionDefaults: targeted("/Users/me/billing"), activity: { lastActivityAt: 1 } }

  test("groups Streams under one static header per Project with every card visible", async () => {
    const request = workGraphRequest({ records: () => [leadStream, secondStream], command: () => success() })
    render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )

    // One quiet section header per Project (derived from each Stream's execution
    // target) and both Stream cards visible without any interaction.
    const claxedo = await screen.findByRole("region", { name: "Project claxedo" })
    const billing = screen.getByRole("region", { name: "Project billing" })
    expect(within(claxedo).getByText("Ship Claxedo cloud")).toBeInTheDocument()
    expect(within(billing).getByText("Migrate billing")).toBeInTheDocument()
  })

  test("collects Streams sharing an execution target under one Project header", async () => {
    const sibling = { ...secondStream, executionDefaults: targeted("/Users/me/claxedo") }
    const request = workGraphRequest({ records: () => [leadStream, sibling], command: () => success() })
    render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )

    const claxedo = await screen.findByRole("region", { name: "Project claxedo" })
    expect(within(claxedo).getByText("Ship Claxedo cloud")).toBeInTheDocument()
    expect(within(claxedo).getByText("Migrate billing")).toBeInTheDocument()
    expect(screen.queryByRole("region", { name: "Project billing" })).toBeNull()
  })

  test("orders a card's task preview by status and summarizes the full breakdown in the footer", async () => {
    // A genuinely staged task (awaiting approval), two approved ready tasks
    // (pending, no incomplete deps), one running, one needs-you, one done.
    const staged = { ...pendingItem, id: "item_pa", title: "Draft the plan", state: "pending_approval" as const, outcomeId: undefined }
    const ready = { ...pendingItem, id: "item_ready", title: "Ship the API", outcomeId: undefined }
    const running = { ...ready, id: "item_running", title: "Cut the release", state: "active" as const }
    const needsYou = { ...ready, id: "item_blocked", title: "Unblock the deploy", state: "blocked" as const }
    const done = { ...ready, id: "item_done", title: "Land the schema", state: "completed" as const }
    const request = workGraphRequest({
      records: () => [stream, done, staged, running, ready, needsYou],
      command: () => success(),
    })
    render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )

    // Preview order: needs-you, running, staged, ready — the done task is pushed
    // past the 4-row preview and lives behind "Show 1 more".
    await screen.findByText("Unblock the deploy")
    const rows = screen.getAllByRole("button", { name: /^Open task / })
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "Open task Unblock the deploy",
      "Open task Cut the release",
      "Open task Draft the plan",
      "Open task Ship the API",
    ])
    // The full breakdown folds behind the stack glyph — done/total on the button,
    // a row per non-empty segment in the fan, and the same breakdown in the
    // button's label (staged · ready · waiting · running · needs you · done).
    expect(
      screen.getByRole("button", { name: "Task breakdown for Ship Claxedo cloud: 1 staged, 1 ready, 1 running, 1 needs you, 1 done" }),
    ).toBeInTheDocument()
    expect(screen.getByText("1 staged")).toBeInTheDocument()
    expect(screen.getByText("1 ready")).toBeInTheDocument()
    expect(screen.getByText("1 running")).toBeInTheDocument()
    expect(screen.getByText("1 needs you")).toBeInTheDocument()
    // Staged + needs-you both block on the owner, so the pill folds them into one.
    expect(screen.getByText("2 need you")).toBeInTheDocument()
    // The overflow continues the task list rather than reporting from the footer.
    expect(screen.getByRole("button", { name: "All tasks for Ship Claxedo cloud" })).toHaveTextContent("Show 1 more")
  })

  test("each Project ends with an empty New stream card that opens the create dialog", async () => {
    const request = workGraphRequest({ records: () => [leadStream], command: () => success() })
    render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )

    await fireEvent.click(await screen.findByRole("button", { name: "New stream in claxedo" }))
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
    expect(screen.getByPlaceholderText("Stream title")).toBeInTheDocument()
  })
})

function workGraphRequest(input: {
  records: () => unknown[]
  command: (command: Record<string, unknown>) => Record<string, unknown>
  run?: (runId: string) => unknown
}) {
  return async (request: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof request === "string" ? request : request instanceof URL ? request : request.url)
    const pathname = url.pathname
    if (pathname.includes("/attention")) return Response.json({ items: [], total: 0, hasMore: false })
    if (pathname.includes("/runs/") && input.run) return Response.json(input.run(pathname.split("/").at(-1)!))
    if (pathname.endsWith("/evidence")) return Response.json({ evidence: [], hasMore: false })
    if (pathname.includes("/work-items/") && pathname.endsWith("/activity")) {
      return Response.json({ entries: [], hasMore: false })
    }
    if (pathname.includes("/work-items/") && pathname.endsWith("/runs")) {
      return Response.json({ runs: [], hasMore: false })
    }
    if (pathname.includes("/work-items/")) {
      const id = pathname.split("/").at(-1)
      const item = input.records().find((record) => (
        !!record && typeof record === "object" && "recordType" in record && record.recordType === "work_item" &&
        "id" in record && record.id === id
      ))
      return Response.json(item)
    }
    if (pathname.endsWith("/defaults"))
      return Response.json({
        recordType: "workgraph",
        schemaVersion: 1,
        ownerUserId: "user_1",
        version: 1,
        createdAt: 1,
        updatedAt: 1,
        provenance: { actor: { type: "user", id: "user_1" } },
        id: "workgraph_default",
        defaults: { execution: {} },
      })
    if (pathname.endsWith("/commands")) {
      const body = JSON.parse(String(init?.body)) as { command: Record<string, unknown> }
      return Response.json(input.command(body.command))
    }
    const records = input.records() as Array<{ recordType: string; id: string; version: number }>
    return Response.json({
      snapshotCursor: "cursor_1",
      records,
      references: records.map((record, index) => ({
        sequence: index + 1,
        resource: { type: record.recordType, id: record.id },
        version: record.version,
      })),
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
  activity: { lastActivityAt: 1 },
  durableEffectCount: 0,
  sourceRevisionRefs: [],
}
const durableStream = { ...stream, durableEffectCount: 2 }
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
  requirements: [
    {
      id: "requirement_1",
      kind: "verification" as const,
      description: "Smoke test passes",
      instructions: "Run the smoke test",
    },
  ],
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
const stagedItem = { ...pendingItem, id: "item_pa", title: "Draft the migration", state: "pending_approval" as const, createdByActorType: "agent" as const, createdByActorId: "agent_planner" }
const runningRun = {
  recordType: "run" as const,
  schemaVersion: 1 as const,
  ownerUserId: "user_1",
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  provenance,
  id: "run_1",
  streamId: "stream_1",
  workItemId: "item_active",
  runNumber: 1,
  generation: 1,
  state: "running" as const,
  resolvedExecution: {
    environment: { kind: "local_worktree" as const },
    harness: "claxedo-v2",
    agent: "build",
    model: { providerId: "openai", modelId: "gpt-5" },
    effort: "high",
    tools: [],
    connectionIds: [],
  },
  admittedAt: 1,
  startedAt: 1,
  sourceRevisionRefs: [],
}
const parkedRun = {
  ...runningRun,
  state: "parked" as const,
  finishedAt: 2,
  parkedReason: "Harness Session request failed",
}
