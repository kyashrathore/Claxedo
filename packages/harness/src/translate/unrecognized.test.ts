import { expect, test } from "bun:test"
import { unrecognizedEvent } from "./unrecognized"

test("unrecognized event retains method and caps raw payload", () => {
  const event = unrecognizedEvent("sample", "future/event", { text: "x".repeat(10000) })
  expect(event.diagnostic).toMatchObject({ code: "unrecognized-event", severity: "warn", source: "sample", method: "future/event" })
  expect(Buffer.byteLength(event.diagnostic.raw as string)).toBeLessThanOrEqual(4096)
})
