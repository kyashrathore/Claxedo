import { expect, test } from "bun:test"
import { createChildSessionHost } from "./session-children"

test("child identity comes from the host's durable keyed identity port", () => {
  const calls: unknown[] = []
  const host = createChildSessionHost({
    deriveSessionId: (input: { callerIdentity: string; clientRequestId: string }) => {
      calls.push(input)
      return "ses_authoritative"
    },
    admit: async () => { throw new Error("unexpected admission") },
    listSubagents: () => [], pendingWakes: () => [], getSession: () => null,
    getMessages: () => [], startTurn: async () => "busy",
  } as Parameters<typeof createChildSessionHost>[0])
  const input = { callerIdentity: "caller", clientRequestId: "request" }
  expect(host.deriveSessionId(input)).toBe("ses_authoritative")
  expect(calls).toEqual([input])
})
