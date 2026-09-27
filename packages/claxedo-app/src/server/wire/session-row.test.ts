/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId, projectId, sessionId } from "../ids"
import { sessionRowFromSession } from "./session-row"

const ref = { projectId: projectId("project-1"), placementId: placementId("placement-1"), sessionId: sessionId("s1") }

test("session row: a session's saved config names its harness, model and permission mode", () => {
  const row = sessionRowFromSession({
    id: "s1",
    time: { created: 1 },
    config: { harness: { id: "claude", access: "native" }, model: { providerID: "claude", modelID: "claude-haiku-4-5-20251001" }, variant: "high", agent: null, permissionMode: "plan" },
  } as Parameters<typeof sessionRowFromSession>[0], ref)
  expect([row.harness, row.model, row.permissionMode]).toEqual([{ kind: "native", harnessId: "claude" }, { providerId: "claude", modelId: "claude-haiku-4-5-20251001", variant: "high" }, "plan"])
  const modelless = sessionRowFromSession({ id: "s1", config: { harness: { id: "scripted-acp", access: "connection" }, variant: null } } as Parameters<typeof sessionRowFromSession>[0], ref)
  expect([modelless.harness, modelless.model]).toEqual([{ kind: "connection", connectionId: "scripted-acp" }, undefined])
  expect(sessionRowFromSession({ id: "s1" }, ref).harness).toBeUndefined()
})
