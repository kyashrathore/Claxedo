import { expect, test } from "bun:test"
import type { CreateElicitationRequest } from "@agentclientprotocol/sdk"
import type { SessionBroker } from "../../contract"
import type { AcpEntry } from "./index"
import { acpSideElicitation } from "./startup"

for (const origin of ["title", "foreign", "parent", "startup", "unbound-request"] as const) test(`ACP elicitation routes ${origin} by upstream session identity`, async () => {
  const asked: unknown[] = []
  const broker = { ask: async (request: unknown) => { asked.push(request); return { kind: "form", values: { answer: "yes" } } } } as unknown as SessionBroker
  const entry = origin === "startup" ? undefined : {
    session: { binding: { upstreamSessionId: "parent" } }, sideSessions: new Map([["title", () => {}]]),
  } as unknown as AcpEntry
  const request: CreateElicitationRequest = { ...(origin === "startup" || origin === "unbound-request" ? { requestId: 1 } : { sessionId: origin }), mode: "form", message: "question",
    requestedSchema: { type: "object", properties: {} } }
  const owned = origin === "parent" || origin === "startup"
  expect(await acpSideElicitation(entry, broker, request, new AbortController().signal)).toEqual(
    owned ? { action: "accept", content: { answer: "yes" } } : { action: "cancel" })
  expect(asked).toHaveLength(owned ? 1 : 0)
})
