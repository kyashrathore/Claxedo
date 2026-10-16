/// <reference types="bun" />
import { expect, test } from "bun:test"
import { toolErrorInputText } from "./tool-error-input"

test("a denied write's card shows the path and content the agent asked to write", () => {
  const text = toolErrorInputText({ path: "/workspace/pi-r28.txt", content: "hello\n" })
  expect(text).toContain('"path": "/workspace/pi-r28.txt"')
  expect(text).toContain('"content": "hello\\n"')
})

test("a failed call that carried no input shows no input", () => {
  expect(toolErrorInputText({})).toBeUndefined()
})
