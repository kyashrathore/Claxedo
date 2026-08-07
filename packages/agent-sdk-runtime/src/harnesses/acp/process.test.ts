import { expect, test } from "bun:test"
import { acpClientCapabilities } from "./process"

test("advertises the Claude ACP subagent transcript extension", () => {
  expect(acpClientCapabilities()).toMatchObject({
    _meta: { "subagent-transcript": true },
  })
})
