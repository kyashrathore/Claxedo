import { describe, expect, test } from "vitest"
import type { ExecutionFact, PersistenceFact, RecoveryOutcome, RecoveryRefusal } from "@claxedo/agent-runtime-contract"
import type { ChannelAbortResult } from "./resolve-session"
import { abortReplyText, abortSettled, turnStopped } from "./session-stop"
import { stoppedTurn } from "./session-stop.fixture"

function outcomeWith(facts: { execution?: ExecutionFact; persistence?: PersistenceFact; cleanup?: "owned" | "unknown" | "verified_clear" }): RecoveryOutcome {
  const base = stoppedTurn("ses_1")
  if (base.kind !== "outcome" || base.outcome.kind !== "operation") throw new Error("the fixture builds an operation")
  const operation = base.outcome.operation
  const evidence = <V extends string>(value: V) => ({ value, source: "fixture", observedAt: 1, generation: "gen_1" })
  return {
    kind: "operation",
    operation: {
      ...operation,
      facts: {
        execution: evidence(facts.execution ?? "terminal"),
        cleanup: evidence(facts.cleanup ?? "unknown"),
        persistence: evidence(facts.persistence ?? "committed"),
      },
    },
  }
}

describe("reading a channel Stop", () => {
  test.each([
    { execution: "terminal" as const, persistence: "committed" as const, stopped: true },
    { execution: "terminal" as const, persistence: "pending" as const, stopped: false },
    { execution: "running" as const, persistence: "committed" as const, stopped: false },
    { execution: "running" as const, persistence: "pending" as const, stopped: false },
  ])("execution $execution with persistence $persistence is stopped=$stopped", ({ execution, persistence, stopped }) => {
    expect(turnStopped(outcomeWith({ execution, persistence }))).toBe(stopped)
  })

  test("the state on the wire never decides it: a needs_action turn with the facts stopped", () => {
    const healthy = stoppedTurn("ses_1")
    if (healthy.kind !== "outcome" || healthy.outcome.kind !== "operation") throw new Error("the fixture builds an operation")

    expect(healthy.outcome.operation.state).toBe("needs_action")
    expect(turnStopped(healthy.outcome)).toBe(true)
    expect(abortSettled(healthy)).toBe(true)
    expect(abortReplyText(healthy)).toBe("Stopped the turn. Whether everything it was using has been released is not verified.")
  })

  test("a verified cleanup is the only reading that promises nothing is left", () => {
    expect(abortReplyText({ kind: "outcome", outcome: outcomeWith({ cleanup: "verified_clear" }) })).toBe("Stopped the turn.")
    expect(abortReplyText({ kind: "outcome", outcome: outcomeWith({ cleanup: "owned" }) }))
      .toBe("Stopped the turn. Whether everything it was using has been released is not verified.")
  })

  test("an idle session is settled without anything having been stopped", () => {
    const idle: ChannelAbortResult = { kind: "no_active_turn" }

    expect(abortSettled(idle)).toBe(true)
    expect(abortReplyText(idle)).toBe("Nothing was running in this session.")
  })

  test("an owner that never answered is never settled", () => {
    const unreachable: ChannelAbortResult = { kind: "unreachable", message: "The machine is offline." }

    expect(abortSettled(unreachable)).toBe(false)
    expect(abortReplyText(unreachable)).toBe("The machine is offline.")
  })

  test.each([
    { execution: "running" as const, reads: "The turn is still running" },
    { execution: "unknown" as const, reads: "Cancelling got no answer" },
  ])("execution $execution reads as a turn that may still be going", ({ execution, reads }) => {
    const result: ChannelAbortResult = { kind: "outcome", outcome: outcomeWith({ execution }) }

    expect(abortSettled(result)).toBe(false)
    expect(abortReplyText(result)).toContain(reads)
  })

  test.each(["pending" as const, "unavailable" as const])("persistence %s says the stop was not saved", (persistence) => {
    const result: ChannelAbortResult = { kind: "outcome", outcome: outcomeWith({ persistence }) }

    expect(abortSettled(result)).toBe(false)
    expect(abortReplyText(result)).toBe("The turn stopped, but where it was interrupted was not saved.")
  })

  test("every refusal kind gets its own wording and none of them settles the thread", () => {
    const refusals: Array<[RecoveryRefusal, string]> = [
      [{ kind: "generation_conflict", message: "replaced" }, "That turn has already ended."],
      [{ kind: "intent_conflict", message: "seen", requestId: "req_1" }, "That command was already used for something else. Send it again."],
      [{ kind: "receipt_expired", message: "late", requestId: "req_1" }, "The stop took too long to confirm. Send the command again."],
      [
        { kind: "scope_changed", message: "wider", scopeRevision: "rev_2", preview: { sessions: ["ses_1"], resources: ["pty_1"], summary: "one session and its terminal" } },
        "Stopping now would interrupt more than it would have a moment ago: one session and its terminal. Send the command again to confirm.",
      ],
      [{ kind: "unauthorized", message: "denied" }, "You are not allowed to stop this session."],
      [{ kind: "unavailable", message: "offline" }, "The machine running this session is unavailable, so nothing was stopped."],
      [{ kind: "version_update_required", message: "old", contractVersion: 4 }, "The machine running this session needs updating before it can stop a turn."],
    ]
    const wordings = new Set<string>()
    for (const [refusal, reads] of refusals) {
      const result: ChannelAbortResult = { kind: "outcome", outcome: { kind: "refused", refusal } }
      expect(abortSettled(result), refusal.kind).toBe(false)
      expect(abortReplyText(result), refusal.kind).toBe(reads)
      wordings.add(reads)
    }
    expect(wordings.size).toBe(refusals.length)
  })
})
