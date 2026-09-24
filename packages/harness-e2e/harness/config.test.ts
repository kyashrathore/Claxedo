import { expect, test } from "bun:test"
import { PI_VERSION, SESSION_TITLE_SYSTEM_PROMPT } from "./config"
import { PI_VERSION as RUNTIME_PI_VERSION } from "../../agent-sdk-runtime/src/harnesses/pi/executable"
import { SESSION_TITLE_SYSTEM_PROMPT as RUNTIME_TITLE_PROMPT } from "../../agent-sdk-runtime/src/title-generation"

test("the e2e Pi pin matches the runtime pin", () => {
  expect(PI_VERSION).toBe(RUNTIME_PI_VERSION)
})

test("the e2e title instruction matches the runtime instruction", () => {
  expect(SESSION_TITLE_SYSTEM_PROMPT).toBe(RUNTIME_TITLE_PROMPT)
})
