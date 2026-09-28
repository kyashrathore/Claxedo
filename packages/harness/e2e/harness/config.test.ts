import { expect, test } from "bun:test"
import { SESSION_TITLE_SYSTEM_PROMPT } from "./config"
import { SESSION_TITLE_SYSTEM_PROMPT as RUNTIME_TITLE_PROMPT } from "../../../workspace-runtime/src/host/title-generation"

test("the e2e title instruction matches the runtime instruction", () => {
  expect(SESSION_TITLE_SYSTEM_PROMPT).toBe(RUNTIME_TITLE_PROMPT)
})
