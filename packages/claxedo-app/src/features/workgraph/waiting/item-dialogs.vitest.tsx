import {
  AdmissionProposalDtoSchema,
  AttemptDetailDtoSchema,
  IntakeCandidateDtoSchema,
  type AttentionItem,
  type CommandResult,
  type DecisionDto,
  WorkItemDtoSchema,
} from "@claxedo/workgraph/contracts"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { TaskDialog, WaitingItemDialog } from "./item-dialogs"
import type { WorkGraphWaitingSource } from "./waiting-source"

afterEach(cleanup)

const owner = { schemaVersion: 1, ownerUserId: "user_1", version: 2, createdAt: 1, updatedAt: 5, provenance: { actor: { type: "user", id: "user_1" } } }

const decision = {
  recordType: "decision",
  schemaVersion: 1,
  ownerUserId: "user_1",
  version: 4,
  createdAt: 1,
  updatedAt: 5,
  provenance: { actor: { type: "user", id: "user_1" } },
  id: "decision_1",
  streamId: "stream_1",
  state: "pending",
  question: "Which auth strategy for the new gateway?",
  options: [
    { id: "o1", label: "OAuth" },
    { id: "o2", label: "SAML" },
  ],
  recommendationOptionId: "o1",
  affectedWorkItemIds: ["i1", "i2"],
  sourceRevisionRefs: [],
} as DecisionDto

const decisionItem = { ownerUserId: "user_1", id: "decision_1", updatedAt: 5, kind: "decision", record: decision } as AttentionItem

function baseSource(overrides: Partial<WorkGraphWaitingSource>): WorkGraphWaitingSource {
  return {
    waiting: vi.fn(),
    proposal: vi.fn(),
    workItem: vi.fn(),
    stream: vi.fn(async () => ({ activityGranularity: "progress" }) as never),
    latestAttempt: vi.fn(),
    activity: vi.fn(async () => ({ entries: [], hasMore: false })),
    evidence: vi.fn(async () => []),
    attempt: vi.fn(),
    decision: vi.fn(async () => decision),
    recap: vi.fn(),
    candidates: vi.fn(),
    defaults: vi.fn(),
    answerDecision: vi.fn(),
    dismissDecision: vi.fn(),
    markNotificationRead: vi.fn(),
    confirmAdmission: vi.fn(),
    dismissAdmission: vi.fn(),
    stageIntakeCandidate: vi.fn(),
    dismissIntakeCandidate: vi.fn(),
    cancelAttempt: vi.fn(),
    retryWorkItem: vi.fn(),
    executeWorkItem: vi.fn(),
    replacementReview: vi.fn(),
    ...overrides,
  } as WorkGraphWaitingSource
}

const proposal = AdmissionProposalDtoSchema.parse({
  recordType: "admission_proposal",
  ...owner,
  id: "prop_1",
  version: 2,
  state: "proposed",
  source: { workSourceId: "ws_1", revisionId: "rev_1", contentHash: "a".repeat(64) },
  generation: { method: "agent_session", sessionId: "sess_1", generatedAt: 1 },
  suggestedPlacement: { mode: "new_stream", streamTitle: "New stream" },
  placementMatches: [],
  proposedOutcomes: [{ key: "o1", title: "Outcome A", successCriteria: ["done"], execution: {} }],
  proposedWorkItems: [{ key: "w1", title: "Task A", dependencyKeys: [], completionContract: { version: 1, mode: "all", requirements: [{ id: "r1", kind: "owner_confirmation", description: "confirm" }] }, execution: {} }],
  duplicateMatches: [],
})
const proposalItem = { ownerUserId: "user_1", id: "prop_1", updatedAt: 5, kind: "admission_proposal", record: { id: "prop_1" } } as AttentionItem

const candidate = (id: string, title: string) => IntakeCandidateDtoSchema.parse({
  id,
  ownerUserId: "user_1",
  version: 1,
  title,
  body: "",
  state: "unorganized",
  createdAt: 1,
  updatedAt: 1,
  candidateKind: "external_issue",
  sourceViewId: "source_view_1",
  provider: "github",
  externalId: id,
  externalKey: `#${id}`,
  externalStatus: "open",
})
const unorganizedItem = { ownerUserId: "user_1", id: "uaw", updatedAt: 5, kind: "unorganized_ai_work", counts: { total: 2, externalIssues: 2, sessions: 0 } } as AttentionItem

const ok: CommandResult = { ok: true, operationId: "op_1", cursor: "c_1", value: {} } as CommandResult

const failedWorkItem = WorkItemDtoSchema.parse({
  recordType: "work_item",
  ...owner,
  id: "work_item_failed",
  streamId: "stream_1",
  title: "Review the launch plan",
  description: "",
  state: "failed",
  priority: 0,
  dependencyIds: [],
  sourceRevisionRefs: [],
  completionContract: {
    version: 1,
    mode: "all",
    requirements: [{ id: "requirement_1", kind: "owner_confirmation", description: "Confirm the review is complete" }],
  },
  evidenceIds: [],
  executionDefaults: {},
})
const failedAttempt = AttemptDetailDtoSchema.parse({
  attempt: {
    recordType: "attempt",
    ...owner,
    id: "attempt_failed",
    streamId: "stream_1",
    workItemId: failedWorkItem.id,
    attemptNumber: 1,
    state: "failed",
    resolvedExecution: {
      environment: { kind: "local_worktree" },
      repository: { baseRevision: "HEAD" },
      harness: "codex-app-server",
      agent: "build",
      model: { providerId: "codex-app-server", modelId: "gpt-5.5" },
      effort: "high",
      tools: [],
      connectionIds: [],
    },
    admittedAt: 1,
    startedAt: 2,
    finishedAt: 3,
    attentionReason: "thread not found: thread_missing",
    sourceRevisionRefs: [],
  },
  executionReferences: { sessionId: "session_failed", workspaceId: "workspace_failed" },
})
const failedWorkItemAttention = {
  ownerUserId: "user_1",
  id: failedWorkItem.id,
  updatedAt: failedWorkItem.updatedAt,
  kind: "work_item",
  record: failedWorkItem,
} as AttentionItem

const previousSourceRef = { workSourceId: "ws_1", revisionId: "rev_0", contentHash: "b".repeat(64) }

// A revision proposal (previousSource set) whose plan targets the existing Stream.
const revisionProposal = AdmissionProposalDtoSchema.parse({
  recordType: "admission_proposal",
  ...owner,
  id: "prop_1",
  version: 2,
  state: "proposed",
  source: { workSourceId: "ws_1", revisionId: "rev_1", contentHash: "a".repeat(64) },
  previousSource: previousSourceRef,
  diffSummary: "Added readiness work.",
  generation: { method: "agent_session", sessionId: "sess_1", generatedAt: 1 },
  suggestedPlacement: { mode: "existing", streamId: "stream_9" },
  placementMatches: [],
  proposedOutcomes: [{ key: "o1", title: "Outcome A", successCriteria: ["done"], execution: {} }],
  proposedWorkItems: [{ key: "w1", title: "Task A", dependencyKeys: [], completionContract: { version: 1, mode: "all", requirements: [{ id: "r1", kind: "owner_confirmation", description: "confirm" }] }, execution: {} }],
  duplicateMatches: [],
})
// Same revision, but planned onto a new Stream — there is no target Stream to keep/replace/fork.
const revisionWithoutTargetStream = AdmissionProposalDtoSchema.parse({
  ...revisionProposal,
  suggestedPlacement: { mode: "new_stream", streamTitle: "New stream" },
})

describe("WaitingItemDialog — decision", () => {
  test("renders rationale with the readable dialog text token", async () => {
    const rationale = "OAuth keeps the gateway aligned with the existing identity boundary."
    const source = baseSource({ decision: vi.fn(async () => ({ ...decision, rationale })) })
    render(() => <WaitingItemDialog selection={decisionItem} source={source} onClose={() => {}} onResolved={() => {}} />)

    const text = await screen.findByText(rationale)
    expect(text).toHaveClass("text-text-base")
    expect(text).not.toHaveClass("text-text-weak")
  })

  test("answers via the domain mutation, then reports resolution and closes", async () => {
    const answerDecision = vi.fn(async () => ok)
    const onResolved = vi.fn()
    const onClose = vi.fn()
    const source = baseSource({ answerDecision })
    render(() => <WaitingItemDialog selection={decisionItem} source={source} onClose={onClose} onResolved={onResolved} />)

    await screen.findByText("Which auth strategy for the new gateway?")
    await fireEvent.click(screen.getByRole("button", { name: /OAuth/ }))

    await waitFor(() => expect(answerDecision).toHaveBeenCalledWith("decision_1", 4, { optionId: "o1" }))
    await waitFor(() => expect(onResolved).toHaveBeenCalled())
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  test("opening does not resolve; a failed transition shows an explicit error and keeps the item", async () => {
    const answerDecision = vi.fn(async () => ({ ok: false, operationId: "op_1", cursor: "c_1", error: { code: "internal_error", message: "backend rejected the answer", retryable: true } }) as CommandResult)
    const onResolved = vi.fn()
    const onClose = vi.fn()
    const source = baseSource({ answerDecision })
    render(() => <WaitingItemDialog selection={decisionItem} source={source} onClose={onClose} onResolved={onResolved} />)

    await screen.findByText("Which auth strategy for the new gateway?")
    await fireEvent.click(screen.getByRole("button", { name: /SAML/ }))

    expect(await screen.findByRole("alert")).toHaveTextContent("backend rejected the answer")
    expect(onResolved).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  test("renders the detail loading state from the strict endpoint", async () => {
    let resolve: (value: DecisionDto) => void = () => {}
    const source = baseSource({ decision: vi.fn(() => new Promise<DecisionDto>((r) => (resolve = r))) })
    render(() => <WaitingItemDialog selection={decisionItem} source={source} onClose={() => {}} onResolved={() => {}} />)
    expect(await screen.findByText("Loading…")).toBeInTheDocument()
    resolve(decision)
    await screen.findByText("Which auth strategy for the new gateway?")
  })
})

describe("WaitingItemDialog — failed task", () => {
  test("shows the stored failure prominently and opens its Session through the supplied app action", async () => {
    const onOpenSession = vi.fn()
    const onClose = vi.fn()
    const source = baseSource({
      workItem: vi.fn(async () => failedWorkItem),
      latestAttempt: vi.fn(async () => failedAttempt),
    })
    render(() => (
      <WaitingItemDialog
        selection={failedWorkItemAttention}
        source={source}
        onClose={onClose}
        onResolved={() => {}}
        onOpenSession={onOpenSession}
      />
    ))

    expect(await screen.findByRole("alert")).toHaveTextContent("thread not found: thread_missing")
    await fireEvent.click(screen.getByRole("button", { name: "Open session session_failed" }))
    expect(onOpenSession).toHaveBeenCalledWith({
      sessionId: "session_failed",
      workspaceId: "workspace_failed",
      harness: failedAttempt.attempt.resolvedExecution.harness,
      environment: failedAttempt.attempt.resolvedExecution.environment,
    })
    expect(onClose).toHaveBeenCalledOnce()
  })

  test("uses a constrained dialog whose body owns vertical scrolling", async () => {
    const source = baseSource({
      workItem: vi.fn(async () => failedWorkItem),
      latestAttempt: vi.fn(async () => failedAttempt),
    })
    render(() => <WaitingItemDialog selection={failedWorkItemAttention} source={source} onClose={() => {}} onResolved={() => {}} />)

    await screen.findByText("Review the launch plan")
    expect(screen.getByRole("dialog").querySelector(".workgraph-item-dialog")).toHaveClass("is-scroll-shell")
    expect(screen.getByRole("dialog").querySelector(".workgraph-item-dialog-body")).toHaveAttribute("data-scrollable", "true")
  })

  test("keeps a Run again action in the fixed footer and closes after retry starts", async () => {
    const retryWorkItem = vi.fn(async () => ok)
    const onResolved = vi.fn()
    const onClose = vi.fn()
    const source = baseSource({
      workItem: vi.fn(async () => failedWorkItem),
      latestAttempt: vi.fn(async () => failedAttempt),
      retryWorkItem,
    })
    render(() => <WaitingItemDialog selection={failedWorkItemAttention} source={source} onClose={onClose} onResolved={onResolved} />)

    await screen.findByText("Review the launch plan")
    const runAgain = screen.getByRole("button", { name: "Run again" })
    expect(runAgain.closest(".workgraph-item-dialog-footer")).not.toBeNull()
    await fireEvent.click(runAgain)

    await waitFor(() => expect(retryWorkItem).toHaveBeenCalledWith(failedWorkItem.id, failedWorkItem.version))
    await waitFor(() => expect(onResolved).toHaveBeenCalledOnce())
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  })
})

describe("TaskDialog — execution and activity", () => {
  test("shows a layout-shaped skeleton while the work item loads, not bare text", async () => {
    let resolve: (value: WorkItemDto) => void = () => {}
    const source = baseSource({
      workItem: vi.fn(() => new Promise<WorkItemDto>((r) => (resolve = r))),
      latestAttempt: vi.fn(async () => undefined),
    })
    render(() => <TaskDialog item={failedWorkItem} source={source} onClose={() => {}} onResolved={() => {}} />)
    expect(await screen.findByRole("status", { name: "Loading task" })).toBeInTheDocument()
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument()
    resolve(failedWorkItem)
    await screen.findByText(failedWorkItem.title)
  })

  test("runs a pending Task directly from the fixed footer", async () => {
    const executeWorkItem = vi.fn(async () => ok)
    const onResolved = vi.fn()
    const onClose = vi.fn()
    const item = { ...failedWorkItem, state: "pending" as const }
    const source = baseSource({
      workItem: vi.fn(async () => item),
      latestAttempt: vi.fn(async () => undefined),
      executeWorkItem,
    })

    render(() => <TaskDialog item={item} source={source} onClose={onClose} onResolved={onResolved} />)
    expect(await screen.findByText("No attempt has run yet.")).toBeInTheDocument()
    const run = screen.getByRole("button", { name: "Run task" })
    expect(run.closest(".workgraph-item-dialog-footer")).not.toBeNull()
    await fireEvent.click(run)

    await waitFor(() => expect(executeWorkItem).toHaveBeenCalledWith(item.id, "autonomous"))
    expect(onResolved).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  test("surfaces state, dependencies, and pending requirement status as static chips", async () => {
    const item = { ...failedWorkItem, dependencyIds: ["dep_1", "dep_2"] }
    const source = baseSource({
      workItem: vi.fn(async () => item),
      latestAttempt: vi.fn(async () => failedAttempt),
      evidence: vi.fn(async () => []),
    })

    render(() => <TaskDialog item={item} source={source} onClose={() => {}} onResolved={() => {}} />)
    const chips = await screen.findByRole("group", { name: "Task status" })
    expect(chips).toHaveTextContent("failed")
    expect(chips).toHaveTextContent("waits for 2 task(s)")
    await waitFor(() => expect(chips).toHaveTextContent("owner confirmation · pending"))
    // The requirement description survives as the chip's tooltip — no information lost.
    expect(within(chips).getByTitle("Confirm the review is complete")).toBeInTheDocument()
  })

  test("marks a satisfied requirement as evidence recorded once its evidence loads", async () => {
    const item = { ...failedWorkItem, state: "result_ready" as const }
    const source = baseSource({
      workItem: vi.fn(async () => item),
      latestAttempt: vi.fn(async () => failedAttempt),
      evidence: vi.fn(async () => [{ requirementId: "requirement_1" }] as never),
    })

    render(() => <TaskDialog item={item} source={source} onClose={() => {}} onResolved={() => {}} />)
    const chips = await screen.findByRole("group", { name: "Task status" })
    await waitFor(() => expect(chips).toHaveTextContent("owner confirmation · evidence recorded"))
  })

  test("appends paginated activity without duplicating an overlapping entry", async () => {
    const activity = vi.fn(async (_id: string, options?: { after?: string }) => options?.after
      ? {
          entries: [activityEntry("activity_1", "First checkpoint"), activityEntry("activity_2", "Evidence recorded")],
          hasMore: false,
        }
      : {
          entries: [activityEntry("activity_1", "First checkpoint")],
          hasMore: true,
          nextCursor: "activity:next",
        })
    const source = baseSource({
      workItem: vi.fn(async () => failedWorkItem),
      latestAttempt: vi.fn(async () => failedAttempt),
      activity: activity as never,
    })

    render(() => <TaskDialog item={failedWorkItem} source={source} onClose={() => {}} onResolved={() => {}} />)
    expect(await screen.findByText("First checkpoint")).toBeInTheDocument()
    await fireEvent.click(screen.getByRole("button", { name: "Load earlier activity" }))
    expect(await screen.findByText("Evidence recorded")).toBeInTheDocument()
    expect(screen.getAllByText("First checkpoint")).toHaveLength(1)
  })

  test("requests activity at the owning Stream's configured detail", async () => {
    const activity = vi.fn(async () => ({ entries: [], hasMore: false }))
    const source = baseSource({
      workItem: vi.fn(async () => failedWorkItem),
      stream: vi.fn(async () => ({ activityGranularity: "detailed" }) as never),
      latestAttempt: vi.fn(async () => failedAttempt),
      activity,
    })

    render(() => <TaskDialog item={failedWorkItem} source={source} onClose={() => {}} onResolved={() => {}} />)
    await screen.findByText("detailed")
    expect(activity).toHaveBeenCalledWith(failedWorkItem.id, { after: undefined, granularity: "detailed", limit: 25 })
  })

  test("closes after handing the real Session to the app shell", async () => {
    const onClose = vi.fn()
    const onOpenSession = vi.fn(async () => {})
    const source = baseSource({
      workItem: vi.fn(async () => failedWorkItem),
      latestAttempt: vi.fn(async () => failedAttempt),
    })

    render(() => <TaskDialog item={failedWorkItem} source={source} onClose={onClose} onResolved={() => {}} onOpenSession={onOpenSession} />)
    await fireEvent.click(await screen.findByRole("button", { name: `Open session ${failedAttempt.executionReferences.sessionId}` }))
    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: failedAttempt.executionReferences.sessionId }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})

function activityEntry(id: string, summary: string) {
  return {
    id,
    streamId: "stream_1",
    workItemId: failedWorkItem.id,
    category: "checkpoint" as const,
    importance: "progress" as const,
    summary,
    occurredAt: 10,
    actor: { type: "agent" as const, id: "session_1" },
    source: { type: "checkpoint" as const, id: `checkpoint_${id}` },
  }
}

describe("WaitingItemDialog — first admission", () => {
  test("keeps an explicit Confirm that submits the plan exactly as proposed", async () => {
    const confirmAdmission = vi.fn(async () => ok)
    const onResolved = vi.fn()
    const onClose = vi.fn()
    const source = baseSource({ proposal: vi.fn(async () => proposal), confirmAdmission })
    render(() => <WaitingItemDialog selection={proposalItem} source={source} onClose={onClose} onResolved={onResolved} />)

    await screen.findByText("Outcomes (1)")
    // First admission shows placement, not the revision dispositions.
    expect(screen.getByText("New stream · New stream")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Keep" })).toBeNull()
    await fireEvent.click(screen.getByRole("button", { name: "Confirm" }))

    await waitFor(() =>
      expect(confirmAdmission).toHaveBeenCalledWith(
        expect.objectContaining({ proposalId: "prop_1", expectedVersion: 2, selection: { mode: "create", streamTitle: "New stream" } }),
      ),
    )
    await waitFor(() => expect(onResolved).toHaveBeenCalled())
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})

describe("WaitingItemDialog — Work Source revision", () => {
  const eligibleReview = {
    streamTitle: "Cloud launch",
    status: "eligible" as const,
    targets: [{ workItemId: "wi_1", expectedVersion: 3, title: "Ship checklist", state: "review_needed" }],
  }

  test("renders exact prior/new source context and the Keep/Replace/Fork choice — no Confirm", async () => {
    const source = baseSource({ proposal: vi.fn(async () => revisionProposal), replacementReview: vi.fn(async () => eligibleReview) })
    render(() => <WaitingItemDialog selection={proposalItem} source={source} onClose={() => {}} onResolved={() => {}} />)

    await screen.findByText("This Work Source was revised")
    expect(screen.getByText("rev_0")).toBeInTheDocument()
    expect(screen.getByText("rev_1")).toBeInTheDocument()
    expect(screen.getByText("Added readiness work.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull()
    expect(screen.getByRole("button", { name: "Keep" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Fork" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Replace" })).toBeInTheDocument()
  })

  test("Keep submits the exact keep contract, then resolves and closes", async () => {
    const confirmAdmission = vi.fn(async () => ok)
    const onResolved = vi.fn()
    const onClose = vi.fn()
    const source = baseSource({ proposal: vi.fn(async () => revisionProposal), replacementReview: vi.fn(async () => eligibleReview), confirmAdmission })
    render(() => <WaitingItemDialog selection={proposalItem} source={source} onClose={onClose} onResolved={onResolved} />)

    await fireEvent.click(await screen.findByRole("button", { name: "Keep" }))

    await waitFor(() =>
      expect(confirmAdmission).toHaveBeenCalledWith(
        expect.objectContaining({
          proposalId: "prop_1",
          expectedVersion: 2,
          selection: { mode: "keep", streamId: "stream_9" },
          workItems: [expect.objectContaining({ proposalKey: "w1", title: "Task A" })],
        }),
      ),
    )
    await waitFor(() => expect(onResolved).toHaveBeenCalled())
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  test("Fork submits the exact fork contract reusing the target Stream title", async () => {
    const confirmAdmission = vi.fn(async () => ok)
    const source = baseSource({ proposal: vi.fn(async () => revisionProposal), replacementReview: vi.fn(async () => eligibleReview), confirmAdmission })
    render(() => <WaitingItemDialog selection={proposalItem} source={source} onClose={() => {}} onResolved={() => {}} />)

    const fork = await screen.findByRole("button", { name: "Fork" })
    await waitFor(() => expect(fork).not.toBeDisabled())
    await fireEvent.click(fork)

    await waitFor(() =>
      expect(confirmAdmission).toHaveBeenCalledWith(
        expect.objectContaining({ selection: { mode: "fork", streamId: "stream_9", streamTitle: "Cloud launch" } }),
      ),
    )
  })

  test("Replace displays the exact reviewed Tasks and submits them as {workItemId, expectedVersion}", async () => {
    const confirmAdmission = vi.fn(async () => ok)
    const source = baseSource({ proposal: vi.fn(async () => revisionProposal), replacementReview: vi.fn(async () => eligibleReview), confirmAdmission })
    render(() => <WaitingItemDialog selection={proposalItem} source={source} onClose={() => {}} onResolved={() => {}} />)

    // The exact reviewed Task is displayed before it can be submitted.
    expect(await screen.findByText("Ship checklist")).toBeInTheDocument()
    const replace = screen.getByRole("button", { name: "Replace" })
    await waitFor(() => expect(replace).not.toBeDisabled())
    await fireEvent.click(replace)

    await waitFor(() =>
      expect(confirmAdmission).toHaveBeenCalledWith(
        expect.objectContaining({ selection: { mode: "replace", streamId: "stream_9", workItems: [{ workItemId: "wi_1", expectedVersion: 3 }] } }),
      ),
    )
  })

  test.each([
    { status: "empty", reason: "No source-linked Tasks are linked to this revision." },
    { status: "stale", reason: "A reviewed Task changed after review; reopen to review again." },
    { status: "unrelated", reason: "This Stream has unrelated nonterminal work; keep or fork instead." },
    { status: "durable", reason: "This Stream recorded durable external effects; keep or fork instead." },
    { status: "unavailable", reason: "The exact current source-linked Tasks are unavailable from this server." },
  ] as const)("Replace stays disabled with a clear reason when targets are $status", async ({ status, reason }) => {
    const confirmAdmission = vi.fn(async () => ok)
    const source = baseSource({
      proposal: vi.fn(async () => revisionProposal),
      replacementReview: vi.fn(async () => ({ streamTitle: "Cloud launch", status, reason })),
      confirmAdmission,
    })
    render(() => <WaitingItemDialog selection={proposalItem} source={source} onClose={() => {}} onResolved={() => {}} />)

    expect(await screen.findByText(reason)).toBeInTheDocument()
    const replace = screen.getByRole("button", { name: "Replace" })
    await waitFor(() => expect(replace).toBeDisabled())
    await fireEvent.click(replace)
    expect(confirmAdmission).not.toHaveBeenCalled()
    // Keep and Fork remain available on every fence.
    expect(screen.getByRole("button", { name: "Keep" })).not.toBeDisabled()
    await waitFor(() => expect(screen.getByRole("button", { name: "Fork" })).not.toBeDisabled())
  })

  test("a revision without a target Stream offers only Dismiss — never a fabricated placement", async () => {
    const replacementReview = vi.fn()
    const source = baseSource({ proposal: vi.fn(async () => revisionWithoutTargetStream), replacementReview })
    render(() => <WaitingItemDialog selection={proposalItem} source={source} onClose={() => {}} onResolved={() => {}} />)

    await screen.findByText("This revision has no target Stream, so it cannot be kept, replaced, or forked.")
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Keep" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Replace" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Fork" })).toBeNull()
    // No target Stream means no eligibility review is even attempted.
    expect(replacementReview).not.toHaveBeenCalled()
  })

  test("surfaces a failed eligibility review explicitly with retry, keeping Replace disabled", async () => {
    const replacementReview = vi.fn(async () => {
      throw new Error("review endpoint offline")
    })
    const source = baseSource({ proposal: vi.fn(async () => revisionProposal), replacementReview })
    render(() => <WaitingItemDialog selection={proposalItem} source={source} onClose={() => {}} onResolved={() => {}} />)

    expect(await screen.findByText("review endpoint offline")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Replace" })).toBeDisabled()
    // Keep never depends on the review, so it stays available.
    expect(screen.getByRole("button", { name: "Keep" })).not.toBeDisabled()
  })
})
