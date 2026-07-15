import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { createComponent } from "solid-js"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { Persist, setPersisted } from "@/platform/persistence/persist"
import { createWorkGraphClient } from "./api"
import { WorkGraphContent } from "./workgraph-content"

// The route-restorable expanded-Stream set persists to localStorage; reset it so
// each test starts from the first-visit default rather than a prior test's set.
beforeEach(() => localStorage.clear())
afterEach(() => cleanup())

describe("WorkGraph overview actions", () => {
  test("opens a pending Task inspector and starts it autonomously", async () => {
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

    await fireEvent.click(await screen.findByRole("button", { name: `Open task ${pendingItem.title}` }))
    expect(await screen.findByText("No attempt has run yet.")).toBeInTheDocument()
    await fireEvent.click(screen.getByRole("button", { name: "Run task" }))

    await waitFor(() => expect(commands).toContainEqual({
      version: 1,
      type: "execute_work_item",
      workItemId: pendingItem.id,
      executionMode: "autonomous",
    }))
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

    expect(await screen.findByText("Local worktree · dev")).toBeInTheDocument()
    expect(screen.queryByText(/inherit/i)).toBeNull()
  })

  test("marks legacy Streams without their own target as requiring configuration", async () => {
    const request = workGraphRequest({ records: () => [stream], command: () => success() })
    render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )

    expect(await screen.findByText("Execution target required")).toBeInTheDocument()
    expect(screen.queryByText(/inherit/i)).toBeNull()
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
    // The explicit Delete action stays put for a fresh, user-initiated attempt.
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

  test("does not offer task abandonment while its Attempt is live", async () => {
    const request = workGraphRequest({
      records: () => [stream, outcome, activeItem, runningAttempt],
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
      records: () => [stream, outcome, activeItem, attentionAttempt],
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
    const secondAttempt = { ...attentionAttempt, id: "attempt_2", workItemId: secondItem.id }
    const commands: Array<Record<string, unknown>> = []
    const request = workGraphRequest({
      records: () => [stream, outcome, activeItem, secondItem, attentionAttempt, secondAttempt],
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
    const earlierAttempt = { ...runningAttempt, state: "result" as const }
    const latestAttempt = {
      ...runningAttempt,
      id: "attempt_2",
      attemptNumber: 2,
      executionReferences: { sessionId: "session_running", workspaceId: "workspace_running" },
    }
    const attemptReads: string[] = []
    const request = workGraphRequest({
      records: () => [stream, outcome, activeItem, earlierAttempt, latestAttempt],
      command: () => success(),
      attempt: (attemptId) => {
        attemptReads.push(attemptId)
        return {
          attempt: latestAttempt,
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
        harness: latestAttempt.resolvedExecution.harness,
        environment: latestAttempt.resolvedExecution.environment,
      }),
    )
    expect(attemptReads).toEqual([])
  })

  test("shows a Stream-owned recap marker only when a latest recap exists, opening a focus/hover preview", async () => {
    let recapReads = 0
    const baseRequest = workGraphRequest({ records: () => [streamWithRecap], command: () => success() })
    const request = (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url)
      if (url.pathname.includes("/recaps/")) recapReads += 1
      return baseRequest(input, init)
    }
    render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )

    const chip = await screen.findByRole("button", { name: "Latest recap for Ship Claxedo cloud" })
    // Hover and keyboard focus on the same mounted trigger share the one lazy read.
    fireEvent.mouseEnter(chip)
    fireEvent.focus(chip)
    expect(await screen.findByText("Shipped idempotency keys and cleaned up retries.")).toBeInTheDocument()
    expect(screen.getByText(/2 actionable refs/)).toBeInTheDocument()
    expect(recapReads).toBe(1)
  })

  test("renders no recap marker for a stream without a latest recap", async () => {
    const request = workGraphRequest({ records: () => [stream], command: () => success() })
    render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )

    await screen.findByText("Ship Claxedo cloud")
    expect(screen.queryByRole("button", { name: /Latest recap for/ })).toBeNull()
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

  test("scopes the inline Add task input name to its Outcome", async () => {
    const request = workGraphRequest({ records: () => [stream, outcome], command: () => success() })
    render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )

    // Both an Outcome-level and a Stream-level "Add task" exist; the Outcome-level one precedes it in the tree.
    const adds = await screen.findAllByRole("button", { name: "Add task" })
    await fireEvent.click(adds[0])
    expect(await screen.findByRole("textbox", { name: "Add task to Claxedo cloud is live" })).toBeInTheDocument()
  })

  test("executes a Stream's ready batch once with the exact supervised command", async () => {
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

    // The ready batch (a pending item with no incomplete dependencies) makes the
    // Stream executable, so the compact trigger appears next to its row controls.
    await fireEvent.click(await screen.findByRole("button", { name: "Execute stream Ship Claxedo cloud" }))
    await fireEvent.click(await screen.findByRole("menuitem", { name: "Supervised" }))

    // Exactly the supervised mode — never an implicit default, never autonomous.
    await waitFor(() =>
      expect(commands).toEqual([
        { version: 1, type: "execute_stream", streamId: "stream_1", executionMode: "supervised" },
      ]),
    )
    expect(commands.some((command) => command.executionMode === "autonomous")).toBe(false)
  })

  test("executes a Stream autonomously with the exact autonomous command", async () => {
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

    await fireEvent.click(await screen.findByRole("button", { name: "Execute stream Ship Claxedo cloud" }))
    await fireEvent.click(await screen.findByRole("menuitem", { name: "Autonomous" }))

    await waitFor(() =>
      expect(commands).toEqual([
        { version: 1, type: "execute_stream", streamId: "stream_1", executionMode: "autonomous" },
      ]),
    )
    expect(commands.some((command) => command.executionMode === "supervised")).toBe(false)
  })

  test("clicking the execute trigger opens its menu without toggling the row", async () => {
    const request = workGraphRequest({ records: () => [stream, outcome, pendingItem], command: () => success() })
    render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )

    // The item is visible because the first Stream renders expanded; clicking the
    // trigger must open the menu, not collapse the Stream out from under it.
    expect(await screen.findByText("Remove obsolete setup")).toBeInTheDocument()
    await fireEvent.click(await screen.findByRole("button", { name: "Execute stream Ship Claxedo cloud" }))
    expect(await screen.findByRole("menu", { name: "Execute stream Ship Claxedo cloud" })).toBeInTheDocument()
    expect(screen.getByText("Remove obsolete setup")).toBeInTheDocument()
  })

  test("offers no execute trigger when no Work Item is a ready batch member", async () => {
    // The only task is already active, so there is no pending, dependency-free
    // Work Item to admit — execution is not semantically allowed.
    const request = workGraphRequest({ records: () => [stream, outcome, activeItem], command: () => success() })
    render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )

    await screen.findByText("Deploy production")
    expect(screen.queryByRole("button", { name: "Execute stream Ship Claxedo cloud" })).toBeNull()
  })

  test("offers no execute trigger while the ready item waits on an incomplete dependency", async () => {
    const blocker = { ...pendingItem, id: "item_blocker", title: "Provision cluster", state: "active" as const }
    const blocked = { ...pendingItem, id: "item_blocked", title: "Deploy service", dependencyIds: ["item_blocker"] }
    const request = workGraphRequest({ records: () => [stream, outcome, blocker, blocked], command: () => success() })
    render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )

    // The pending item's dependency is not completed, so the batch is not ready.
    await screen.findByText("Deploy service")
    expect(screen.queryByRole("button", { name: "Execute stream Ship Claxedo cloud" })).toBeNull()
  })

  test("offers no execute trigger for a paused Stream even with a ready batch", async () => {
    const pausedStream = { ...stream, lifecycleState: "paused" as const }
    const request = workGraphRequest({ records: () => [pausedStream, outcome, pendingItem], command: () => success() })
    render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )

    await screen.findByText("Ship Claxedo cloud")
    expect(screen.queryByRole("button", { name: "Execute stream Ship Claxedo cloud" })).toBeNull()
  })

  test("exposes the lazy recap popover with a stable accessible role and name", async () => {
    const request = workGraphRequest({ records: () => [streamWithRecap], command: () => success() })
    render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )

    fireEvent.focus(await screen.findByRole("button", { name: "Latest recap for Ship Claxedo cloud" }))
    // Stable regardless of the loading/error/loaded content the popover shows inside.
    expect(await screen.findByRole("group", { name: "Latest recap" })).toBeInTheDocument()
  })
})

// AE10 — the expanded-Stream set is route-restorable: it survives a /workgraph
// reload, spans multiple Streams, and restores only real Streams.
describe("WorkGraph expanded-Stream restoration", () => {
  const leadStream = { ...stream, id: "stream_1", title: "Ship Claxedo cloud", activity: { lastActivityAt: 2, recapDueAt: 2 } }
  const secondStream = { ...stream, id: "stream_2", title: "Migrate billing", activity: { lastActivityAt: 1, recapDueAt: 2 } }

  test("restores the expanded Stream set across a route reload for multiple Streams", async () => {
    const request = workGraphRequest({ records: () => [leadStream, secondStream], command: () => success() })
    const first = render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )
    // First visit: the lead Stream auto-expands; the second starts collapsed.
    await screen.findByRole("button", { name: "Collapse Ship Claxedo cloud" })
    await fireEvent.click(screen.getByRole("button", { name: "Expand Migrate billing" }))
    await screen.findByRole("button", { name: "Collapse Migrate billing" })

    // Leave and reload /workgraph.
    first.unmount()
    render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )

    // Both Streams come back expanded from the persisted set — the reload does not
    // reset to the first-visit default of only the lead Stream.
    expect(await screen.findByRole("button", { name: "Collapse Ship Claxedo cloud" })).toBeInTheDocument()
    expect(await screen.findByRole("button", { name: "Collapse Migrate billing" })).toBeInTheDocument()
  })

  test("restores only real Streams, never fabricating a phantom row for an unknown id", async () => {
    // A persisted map naming a Stream that no longer exists must be inert, and an
    // explicit collapse of the lead must be honored over the default.
    setPersisted(Persist.global("workgraph.expanded-streams.v1"), {
      ids: { stream_1: false, stream_2: true, ghost_stream: true },
    })
    const request = workGraphRequest({ records: () => [leadStream, secondStream], command: () => success() })
    render(() =>
      createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }) }),
    )

    // The explicit choices are restored (lead collapsed, second expanded) and the
    // unknown id renders no disclosure row at all — exactly two Streams.
    expect(await screen.findByRole("button", { name: "Expand Ship Claxedo cloud" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Collapse Migrate billing" })).toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: /^(Collapse|Expand) / })).toHaveLength(2)
    expect(within(document.body).queryByText(/ghost/i)).toBeNull()
  })
})

// Faithful bounded /changes long-poll: with no changes to deliver and a positive
// waitMs, hold the request open until the client aborts it, then answer timedOut —
// so the synchronizer re-issues its next poll instead of tight-looping.
function holdLongPoll(url: URL, init?: RequestInit): Response | Promise<Response> {
  const after = url.searchParams.get("after") ?? undefined
  const timedOutBody = { changes: [] as unknown[], ...(after ? { cursor: after } : {}), timedOut: true }
  if (Number(url.searchParams.get("waitMs") ?? "0") <= 0) {
    return Response.json({ changes: [], ...(after ? { cursor: after } : {}), timedOut: false })
  }
  const signal = init?.signal
  if (!signal || signal.aborted) return Response.json(timedOutBody)
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(Response.json(timedOutBody)), { once: true }))
}

function workGraphRequest(input: {
  records: () => unknown[]
  command: (command: Record<string, unknown>) => Record<string, unknown>
  attempt?: (attemptId: string) => unknown
}) {
  return async (request: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof request === "string" ? request : request instanceof URL ? request : request.url)
    const pathname = url.pathname
    if (pathname.endsWith("/changes")) return holdLongPoll(url, init)
    if (pathname.includes("/attention")) return Response.json({ items: [], total: 0, hasMore: false })
    if (pathname.includes("/recaps/")) return Response.json(recap)
    if (pathname.includes("/attempts/") && input.attempt) return Response.json(input.attempt(pathname.split("/").at(-1)!))
    if (pathname.endsWith("/notifications")) return Response.json({ notifications: [], hasMore: false })
    if (pathname.endsWith("/evidence")) return Response.json({ evidence: [], hasMore: false })
    if (pathname.includes("/work-items/") && pathname.endsWith("/activity")) {
      return Response.json({ entries: [], hasMore: false })
    }
    if (pathname.includes("/work-items/") && pathname.endsWith("/attempts")) {
      return Response.json({ attempts: [], hasMore: false })
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
  recapDefaults: {},
  activity: { lastActivityAt: 1, recapDueAt: 2 },
  durableEffectCount: 0,
  sourceRevisionRefs: [],
}
const durableStream = { ...stream, durableEffectCount: 2 }
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
  },
  admittedAt: 1,
  startedAt: 1,
  sourceRevisionRefs: [],
}
const attentionAttempt = {
  ...runningAttempt,
  state: "attention" as const,
  finishedAt: 2,
  attentionReason: "Harness Session request failed",
}
