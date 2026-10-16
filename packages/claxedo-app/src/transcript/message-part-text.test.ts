/// <reference types="bun" />
import { expect, test } from "bun:test"
import { responseText, toolErrorInputText } from "./message-part-text"

test("the copied response is each answer part's drawn text, joined by a blank line", () => {
  expect(responseText([{ text: "Yep, all good! Fill me in and I'll get going\n" }, { text: ".\n" }])).toBe("Yep, all good! Fill me in and I'll get going\n\n.")
  expect(responseText([{ text: "Only this." }])).toBe("Only this.")
})

test("a denied write's card shows the path and content the agent asked to write", () => {
  const text = toolErrorInputText({ path: "/workspace/pi-r28.txt", content: "hello\n" })
  expect(text).toContain('"path": "/workspace/pi-r28.txt"')
  expect(text).toContain('"content": "hello\\n"')
})

test("a failed call that carried no input shows no input", () => {
  expect(toolErrorInputText({})).toBeUndefined()
})
