import type { AdmissionProposalDto, AttentionItem, CommandResult, DecisionDto, IntakeCandidateDto } from "@claxedo/workgraph/contracts"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { WaitingItemDialog } from "./item-dialogs"
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
    latestAttempt: vi.fn(),
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
    ...overrides,
  } as WorkGraphWaitingSource
}

const proposal = {
  recordType: "admission_proposal",
  ...owner,
  id: "prop_1",
  version: 2,
  state: "proposed",
  source: { workSourceId: "ws_1", revisionId: "rev_1", contentHash: "hash_1" },
  generation: { method: "agent_session", sessionId: "sess_1", generatedAt: 1 },
  suggestedPlacement: { mode: "new_stream", streamTitle: "New stream" },
  placementMatches: [],
  proposedOutcomes: [{ key: "o1", title: "Outcome A", successCriteria: ["done"], execution: {} }],
  proposedWorkItems: [{ key: "w1", title: "Task A", dependencyKeys: [], completionContract: { version: 1, mode: "all", requirements: [{ id: "r1", kind: "owner_confirmation", description: "confirm" }] }, execution: {} }],
  duplicateMatches: [],
  // as-any: minimal proposal projection; omits owner provenance the dialog never reads.
} as unknown as AdmissionProposalDto
const proposalItem = { ownerUserId: "user_1", id: "prop_1", updatedAt: 5, kind: "admission_proposal", record: { id: "prop_1" } } as AttentionItem

const candidate = (id: string, title: string): IntakeCandidateDto =>
  // as-any: minimal external-issue candidate projection; omits owner metadata unused here.
  ({ id, candidateKind: "external_issue", externalKey: `#${id}`, title, provider: "github", externalStatus: "open", state: "unorganized", version: 1 }) as unknown as IntakeCandidateDto
const unorganizedItem = { ownerUserId: "user_1", id: "uaw", updatedAt: 5, kind: "unorganized_ai_work", counts: { total: 2, externalIssues: 2, sessions: 0 } } as AttentionItem

const ok: CommandResult = { ok: true, operationId: "op_1", cursor: "c_1", value: {} } as CommandResult

describe("WaitingItemDialog — decision", () => {
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
