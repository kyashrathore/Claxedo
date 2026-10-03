import { expect, test } from "bun:test"
import type { SessionAttentionFacts } from "@claxedo/agent-runtime-contract"
import { createSessionPublicationOrigins } from "./publication-origin"

const ref = { workspaceId: "workspace", sessionId: "session" }
const facts: SessionAttentionFacts = { generation: 1, sequence: 4, activitySequence: 2, activityAt: 100,
  working: true, awaitingInput: false }


test("metadata changes preserve recovery provenance until canonical activity advances", () => {
  const origins = createSessionPublicationOrigins()
  const idle = { ...facts, working: false }
  expect(origins.remember(ref, idle, true)).toBe(true)
  expect(origins.remember(ref, idle, false)).toBe(true)
  expect(origins.remember(ref, { ...idle, sequence: 5 }, false)).toBe(true)
  expect(origins.remember(ref, { ...idle, sequence: 6, activitySequence: 6 }, false)).toBe(false)
  expect(origins.remember(ref, facts, true)).toBe(true)
})

test("older collected rows cannot replace an observed newer live row or generation", () => {
  const origins = createSessionPublicationOrigins()
  expect(origins.remember(ref, facts, true)).toBe(true)
  const live = { ...facts, sequence: 8, activitySequence: 8 }
  expect(origins.remember(ref, live, false)).toBe(false)
  expect(origins.remember(ref, { ...facts, sequence: 5 }, true)).toBe(true)
  expect(origins.remember(ref, live, true)).toBe(false)
  const next = { ...facts, generation: 10, sequence: 12, activitySequence: 12 }
  expect(origins.remember(ref, next, false)).toBe(false)
  expect(origins.remember(ref, live, true)).toBe(true)
  expect(origins.remember(ref, next, true)).toBe(false)
})
