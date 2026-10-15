/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { PromptInput } from "../types"
import { promptBody, promptEcho } from "./prompt"

const input: PromptInput = {
  clientRequestId: "c1",
  text: "Fix the build",
  attachments: [
    { kind: "file", path: "/repo/src/main.ts" },
    { kind: "text", text: "line 4 throws", label: "src/main.ts:4" },
  ],
  model: { providerId: "anthropic", modelId: "claude-haiku-4-5-20251001" },
}

test("prompt echo: the predicted user message carries the parts the body sends, under the message's own ids", () => {
  const echo = promptEcho(input, { sessionId: "s1", messageId: "m1", created: 7 })

  expect(echo.info).toEqual({
    id: "m1",
    sessionID: "s1",
    role: "user",
    time: { created: 7 },
    model: { providerID: "anthropic", modelID: "claude-haiku-4-5-20251001" },
  })
  expect(echo.parts).toEqual(promptBody(input, "m1").parts.map((part, index) => ({ ...part, id: `m1-part-${index}`, sessionID: "s1", messageID: "m1" })))
})

test("prompt wire: the body and the echo name an agent only when the person chose one; the app never invents the engine's default", () => {
  expect("agent" in promptBody(input, "m1")).toBe(false)
  const chosen = { ...input, agent: "plan" }
  expect(promptBody(chosen, "m1").agent).toBe("plan")
  expect(promptEcho(chosen, { sessionId: "s1", messageId: "m1", created: 7 }).info.agent).toBe("plan")
})
