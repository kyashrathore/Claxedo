import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"
import { afterEach, expect, test, vi } from "vitest"
import type {
  CleanupFact,
  ExecutionFact,
  PersistenceFact,
  RecoveryOperation,
  RecoveryOutcome,
  RecoveryRequest,
} from "@claxedo/agent-runtime-contract"
import { SessionRecoveryPanel, type SessionRecoveryClient } from "./session-recovery"
import { clearSessionRecoveryCommand, startSessionRecoveryCommand, settleSessionRecoveryCommand } from "../store/session-status-dispatcher"

vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${Object.values(params).join(",")}` : key,
  }),
}))

afterEach(() => {
  cleanup()
  clearSessionRecoveryCommand("ses_1")
})

const target = {
  scope: "turn" as const,
  workspaceId: "ws_1",
  sessionId: "ses_1",
  turnId: "msg_1",
  ownerGeneration: "lease_1",
}

const NOW = 1_700_000_010_000

function evidence<V extends string>(value: V, source: string) {
  return { value, source, observedAt: NOW - 4_000, generation: "lease_1" }
}

function facts(execution: ExecutionFact, cleanup: CleanupFact, persistence: PersistenceFact) {
  return {
    execution: evidence(execution, "codex"),
    cleanup: evidence(cleanup, "process-owner"),
    persistence: evidence(persistence, "store"),
  }
}

function operation(over?: Partial<RecoveryOperation>): RecoveryOperation {
  return {
    operationId: "op_1",
    requestId: "req_1",
    target,
    action: "cancel_turn",
    scopeRevision: "lease_1",
    attempt: 1,
    state: "needs_action",
    phase: "graceful_cancel",
    phaseDeadlineAt: NOW,
    facts: facts("unknown", "owned", "pending"),
    cleanupErrors: [],
    nextActions: [],
    receipt: "durable",
    createdAt: NOW - 5_000,
    updatedAt: NOW - 4_000,
    ...over,
  }
}

function inspection(over?: Partial<Parameters<typeof panel>[0]["inspection"]>) {
  return {
    sessionId: "ses_1",
    target,
    facts: facts("unknown", "owned", "pending"),
    health: { status: "degraded" as const, reason: "retained finalization failure" },
    failures: [],
    operations: [operation()],
    queued: 0,
    ...over,
  }
}

function panel(input: {
  inspection?: ReturnType<typeof inspection> | RecoveryOutcome
  submit?: (request: RecoveryRequest) => RecoveryOutcome
  submitPromise?: (request: RecoveryRequest) => Promise<RecoveryOutcome>
  onInspect?: () => void
}) {
  const requests: RecoveryRequest[] = []
  const client: SessionRecoveryClient = {
    session: {
      recovery: {
        inspect: async () => {
          input.onInspect?.()
          return { data: input.inspection ?? inspection() }
        },
        submit: async ({ request }) => {
          requests.push(request)
          if (input.submitPromise) return { data: await input.submitPromise(request) }
          return { data: input.submit?.(request) ?? { kind: "operation", operation: operation({ requestId: request.requestId }) } }
        },
      },
    },
  }
  const view = render(() => (
    <SessionRecoveryPanel sessionID="ses_1" directory="/repo" client={client} now={() => NOW} />
  ))
  return { view, requests }
}

test("shows the three facts with the source and age the owner reported", async () => {
  const { view } = panel({})

  await waitFor(() => expect(view.getByText("session.recovery.fact.execution")).toBeTruthy())
  expect(view.getByText("session.recovery.value.executionUnknown")).toBeTruthy()
  expect(view.getByText("session.recovery.value.owned")).toBeTruthy()
  expect(view.getByText("session.recovery.value.pending")).toBeTruthy()
  // source and the age in seconds, both from the evidence rather than now().
  expect(view.getAllByText("session.recovery.panel.source:codex,4").length).toBeGreaterThan(0)
  expect(view.getByText("session.recovery.panel.health:degraded")).toBeTruthy()
})

test("a machine that cannot answer is shown as that, not as unknown facts", async () => {
  const { view } = panel({
    inspection: { kind: "refused", refusal: { kind: "unavailable", message: "no owner on this machine" } },
  })

  await waitFor(() => expect(view.getByRole("alert").textContent).toContain("session.recovery.machine_unavailable.title"))
  expect(view.queryByText("session.recovery.fact.execution")).toBeNull()
  expect(view.getByRole("button", { name: "session.recovery.panel.inspect" })).toBeTruthy()
})

test("an interruption that was never saved reads as a save failure, not as a running turn", async () => {
  clearSessionRecoveryCommand("ses_1")
  startSessionRecoveryCommand({ sessionID: "ses_1", requestId: "req_1", action: "cancel_turn", attempt: 1 })
  settleSessionRecoveryCommand({
    sessionID: "ses_1",
    requestId: "req_1",
    outcome: { kind: "operation", operation: operation({ facts: facts("terminal", "unknown", "unavailable") }) },
  })

  const { view } = panel({})

  await waitFor(() => expect(view.getByRole("status").textContent).toContain("session.recovery.save_failed.title"))
})

test("a stop still in flight says so without claiming an outcome", async () => {
  clearSessionRecoveryCommand("ses_1")
  startSessionRecoveryCommand({ sessionID: "ses_1", requestId: "req_1", action: "cancel_turn", attempt: 1 })

  const { view } = panel({})

  await waitFor(() => expect(view.getByText("session.recovery.panel.stopping")).toBeTruthy())
  expect(view.queryByRole("status")).toBeNull()
})

test("Reconcile names the admitted turn and re-reads the owner afterwards", async () => {
  let inspects = 0
  const { view, requests } = panel({ onInspect: () => { inspects += 1 } })

  await waitFor(() => expect(view.getByRole("button", { name: "session.recovery.panel.reconcile" })).toBeTruthy())
  expect(inspects).toBe(1)
  fireEvent.click(view.getByRole("button", { name: "session.recovery.panel.reconcile" }))

  await waitFor(() => expect(requests).toHaveLength(1))
  expect(requests[0].action).toBe("reconcile_session")
  expect(requests[0].target).toEqual(target)
  expect(requests[0].scopeRevision).toBe("lease_1")
  await waitFor(() => expect(inspects).toBe(2))
})

test("Retry opens a new attempt linked to the cancellation it follows", async () => {
  const { view, requests } = panel({})

  await waitFor(() => expect(view.getByRole("button", { name: "session.recovery.panel.retry" })).toBeTruthy())
  fireEvent.click(view.getByRole("button", { name: "session.recovery.panel.retry" }))

  await waitFor(() => expect(requests).toHaveLength(1))
  expect(requests[0].action).toBe("cancel_turn")
  expect(requests[0].attempt).toBe(2)
  expect(requests[0].linkedOperationId).toBe("op_1")
})

test("a session with no admitted turn offers inspection but nothing to reconcile", async () => {
  const { view } = panel({ inspection: inspection({ target: undefined }) })

  await waitFor(() => expect(view.getByText("session.recovery.panel.reconcileUnavailable")).toBeTruthy())
  expect(view.queryByRole("button", { name: "session.recovery.panel.reconcile" })).toBeNull()
  expect(view.queryByRole("button", { name: "session.recovery.panel.retry" })).toBeNull()
  expect(view.getByRole("button", { name: "session.recovery.panel.inspect" })).toBeTruthy()
})

test("retained owner failures and parked prompts are listed", async () => {
  const { view } = panel({
    inspection: inspection({
      queued: 2,
      failures: [{
        code: "persistence_unavailable",
        origin: "workspace-store",
        target,
        stage: "reconcile",
        executionMayContinue: false,
        message: "the journal is not writable",
        at: NOW - 1_000,
      }],
    }),
  })

  await waitFor(() => expect(view.getByText("session.recovery.panel.queued:2")).toBeTruthy())
  expect(view.getByText(/the journal is not writable/)).toBeTruthy()
  expect(view.getByText(/persistence_unavailable/)).toBeTruthy()
})

test("an operation whose receipt never reached storage is marked as unsaved", async () => {
  const { view } = panel({ inspection: inspection({ operations: [operation({ receipt: "volatile" })] }) })

  await waitFor(() => expect(view.getByText("session.recovery.panel.volatile")).toBeTruthy())
})

test("every action is reachable by keyboard, and one running action locks the rest", async () => {
  let answer!: (outcome: RecoveryOutcome) => void
  const { view } = panel({ submitPromise: () => new Promise<RecoveryOutcome>((resolve) => { answer = resolve }) })
  await waitFor(() => expect(view.getByRole("button", { name: "session.recovery.panel.retry" })).toBeTruthy())

  const buttons = view.getAllByRole("button") as HTMLButtonElement[]
  expect(buttons).toHaveLength(3)
  for (const button of buttons) {
    button.focus()
    expect(document.activeElement).toBe(button)
    expect(button.disabled).toBe(false)
  }

  fireEvent.click(view.getByRole("button", { name: "session.recovery.panel.reconcile" }))
  await waitFor(() => expect((view.getAllByRole("button") as HTMLButtonElement[]).every((button) => button.disabled)).toBe(true))

  answer({ kind: "operation", operation: operation() })
  await waitFor(() => expect((view.getAllByRole("button") as HTMLButtonElement[]).some((button) => !button.disabled)).toBe(true))
})

test("the panel announces the result of an action politely", async () => {
  const { view } = panel({})

  await waitFor(() => expect(view.getByRole("button", { name: "session.recovery.panel.inspect" })).toBeTruthy())
  fireEvent.click(view.getByRole("button", { name: "session.recovery.panel.inspect" }))

  const live = view.container.querySelector('[aria-live="polite"]')
  await waitFor(() => expect(live?.textContent).toBe("session.recovery.panel.inspected"))
})
