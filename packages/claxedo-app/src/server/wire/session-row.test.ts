/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId, projectId, sessionId } from "../ids"
import { sessionRowFromSession } from "./session-row"

const ref = { projectId: projectId("project-1"), placementId: placementId("placement-1"), sessionId: sessionId("s1") }

test("session row: a session's saved config names its harness and model", () => {
  const row = sessionRowFromSession({
    id: "s1",
    time: { created: 1 },
    config: { harness: { id: "pi", access: "native" }, model: { providerID: "pi", modelID: "anthropic/claude-opus-4-8" }, variant: "high", agent: null },
  } as Parameters<typeof sessionRowFromSession>[0], ref)
  expect([row.harness, row.model]).toEqual([{ kind: "native", harnessId: "pi" }, { providerId: "pi", modelId: "anthropic/claude-opus-4-8", variant: "high" }])
  const modelless = sessionRowFromSession({ id: "s1", config: { harness: { id: "scripted-acp", access: "connection" }, variant: null } } as Parameters<typeof sessionRowFromSession>[0], ref)
  expect([modelless.harness, modelless.model]).toEqual([{ kind: "connection", connectionId: "scripted-acp" }, undefined])
  expect(sessionRowFromSession({ id: "s1" }, ref).harness).toBeUndefined()
})
