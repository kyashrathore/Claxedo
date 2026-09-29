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
    // down the SSE connection for every subscriber — and is still the
    // session's when its properties name one.
    expect(eventSessionId({ type: "session.updated", properties: { sessionID: "x" } } as never)).toBe("x")
    expect(eventSessionId({ type: "session.updated", properties: {} } as never)).toBeUndefined()
    expect(eventSessionId({ type: "session.updated" } as never)).toBeUndefined()
    expect(eventSessionId({ type: "message.updated", properties: {} } as never)).toBeUndefined()
    expect(eventSessionId({ type: "message.part.updated", properties: {} } as never)).toBeUndefined()
  })

  it("reads the session off a type it does not name, so a new kind is never workspace-wide by omission", () => {
    expect(eventSessionId({ type: "message.removed", properties: { sessionID: "ses_5", messageID: "msg" } } as never)).toBe("ses_5")
    expect(eventSessionId({ type: "message.part.removed", properties: { sessionID: "ses_6" } } as never)).toBe("ses_6")
    expect(eventSessionId({ type: "something.new", properties: { info: { sessionID: "ses_7" } } } as never)).toBe("ses_7")
    expect(eventSessionId({ type: "something.new", properties: {} } as never)).toBeUndefined()
  })
})
