import { describe, expect, it } from "bun:test"
import { eventSessionId } from "./compat-events"

describe("eventSessionId", () => {
  it("extracts the session id from canonical frames", () => {
    expect(eventSessionId({ type: "session.updated", properties: { info: { id: "ses_1" } } } as never)).toBe("ses_1")
    expect(eventSessionId({ type: "message.updated", properties: { info: { sessionID: "ses_2" } } } as never)).toBe("ses_2")
    expect(eventSessionId({ type: "message.part.updated", properties: { part: { sessionID: "ses_3" } } } as never)).toBe("ses_3")
    expect(eventSessionId({ type: "session.error", properties: { sessionID: "ses_4" } } as never)).toBe("ses_4")
  })

  it("returns undefined for partial/malformed frames instead of throwing", () => {
    // The global event stream carries untrusted upstream frames. A partial
    // session.updated (no `info`) must NOT crash the transform — that would tear
    // down the SSE connection for every subscriber.
    expect(eventSessionId({ type: "session.updated", properties: { sessionID: "x" } } as never)).toBeUndefined()
    expect(eventSessionId({ type: "session.updated", properties: {} } as never)).toBeUndefined()
    expect(eventSessionId({ type: "session.updated" } as never)).toBeUndefined()
    expect(eventSessionId({ type: "message.updated", properties: {} } as never)).toBeUndefined()
    expect(eventSessionId({ type: "message.part.updated", properties: {} } as never)).toBeUndefined()
  })
})
