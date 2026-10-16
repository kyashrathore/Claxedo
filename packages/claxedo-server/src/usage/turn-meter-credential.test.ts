import { describe, expect, test } from "vitest"
import type { AgentEventEnvelope, TurnAccount } from "@claxedo/agent-runtime-contract"
import type { TurnUsageRevision, UsageRevisionWriteResult } from "@claxedo/server-core/usage/contracts"
import { createTurnMeter } from "@claxedo/server-core/usage/turn-meter"
import { buildAssistantMessage, messageCompleted, messageUpdated, sessionError, sessionUsage } from "@claxedo/session-core"

const TEAM_KEY: TurnAccount = { kind: "stored", harnessId: "claude", credentialId: "cred_team", providerId: "anthropic", label: "Team", revision: 3 }
const TOKENS = { input: 10, output: 2, reasoning: null, cache: { read: null, write: null } }

function metered() {
  const facts: TurnUsageRevision[] = []
  const meter = createTurnMeter({
    writer: {
      async writeRevision(fact): Promise<UsageRevisionWriteResult> {
        facts.push(fact)
        return { status: "accepted" }
      },
    },
    resolveContext: async ({ sessionId }) => ({
      sessionRef: `workspace:ws-1:session:${sessionId}`,
      workspaceId: "ws-1",
      hostId: "workspace:ws-1",
      location: "cloud-workspace",
      harness: "claude",
    }),
    now: () => 9_000,
  })
  return { meter, facts }
}

const envelope = (payload: AgentEventEnvelope["payload"]): AgentEventEnvelope => ({ directory: "/w", payload })

function assistant(input: { completed?: number; error?: Record<string, unknown> } = {}) {
  const row = buildAssistantMessage({
    id: "msg-1",
    sessionID: "session-1",
    parentID: "user-1",
    agent: "build",
    model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
    directory: "/w",
    created: 100,
    ...(input.completed ? { completed: input.completed } : {}),
  })
  return input.error ? { ...row, error: input.error } : row
}

describe("the credential a metered turn names", () => {
  test("is the stored credential the harness spent the turn's tokens on, by id alone, on every revision after it is known", async () => {
    const { meter, facts } = metered()
    await meter.consume(envelope(messageUpdated(assistant() as never)))
    await meter.consume(envelope(sessionUsage({
      sessionID: "session-1", messageID: "msg-1", contextSize: 0, contextUsed: 10, account: TEAM_KEY,
      observation: { kind: "cumulative", observedAt: 1_000, tokens: TOKENS },
    })))
    await meter.consume(envelope(messageCompleted("session-1", "msg-1")))

    expect(facts.map((fact) => [fact.settlement, fact.credential])).toEqual([
      ["provisional", undefined],
      ["provisional", { kind: "stored", credentialId: "cred_team" }],
      ["final", { kind: "stored", credentialId: "cred_team" }],
    ])
  })

  test("is the harness's own login when the turn ran on no stored credential, as a failed turn's error names it", async () => {
    const { meter, facts } = metered()
    await meter.consume(envelope(messageUpdated(assistant() as never)))
    await meter.consume(envelope(sessionError("401", "session-1", { account: { kind: "machine", harnessId: "claude" } })))

    expect(facts.at(-1)).toMatchObject({ status: "error", credential: { kind: "machine" } })
  })

  test("is read off a failed assistant message's error when no usage named it", async () => {
    const { meter, facts } = metered()
    const error = { name: "UnknownError", data: { message: "401", account: TEAM_KEY } }
    await meter.consume(envelope(messageUpdated(assistant({ completed: 2_000, error }) as never)))

    expect(facts.at(-1)).toMatchObject({ status: "error", credential: { kind: "stored", credentialId: "cred_team" } })
  })

  test("is absent when nothing the turn reported named an account", async () => {
    const { meter, facts } = metered()
    await meter.consume(envelope(sessionUsage({
      sessionID: "session-1", messageID: "msg-1", contextSize: 0, contextUsed: 10,
      observation: { kind: "cumulative", observedAt: 1_000, tokens: TOKENS },
    })))
    await meter.consume(envelope(messageCompleted("session-1", "msg-1")))

    expect(facts.at(-1)).toMatchObject({ settlement: "final" })
    expect(facts.every((fact) => !("credential" in fact))).toBe(true)
  })
})
