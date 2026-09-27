import { expect, test } from "bun:test"
import { acceptedSessionUpdate } from "./accepted-session-mutation"
import type { AgentRuntimeStoreCore } from "./runtime-store"

const store = {
  getSession: (id: string) => ({ id, title: "Before", time: { created: 1, updated: 7 } }),
} as unknown as AgentRuntimeStoreCore

test("an accepted rename or archive keeps the store's times and adds only the archive the caller named", () => {
  expect(acceptedSessionUpdate(store, "ses_1", { title: "After" })).toEqual({
    id: "ses_1",
    title: "After",
    time: { created: 1, updated: 7 },
  })
  expect(acceptedSessionUpdate(store, "ses_1", { time: { archived: 9 } })).toEqual({
    id: "ses_1",
    title: "Before",
    time: { created: 1, updated: 7, archived: 9 },
  })
})
