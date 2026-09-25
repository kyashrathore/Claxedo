import { expect, test } from "bun:test"
import { piEvents } from "./events"

test("Pi translator preserves an unrecognized RPC event", () => {
  expect(piEvents("s1")({ type: "future_event", value: 1 })[0]?.event).toMatchObject({ type: "diagnostic", diagnostic: {
    code: "unrecognized-event", source: "pi.rpc", method: "future_event",
  } })
})
