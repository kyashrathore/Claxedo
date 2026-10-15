/// <reference types="bun" />
import { expect, test } from "bun:test"
import { responseText } from "./message-part-text"

test("the copied response is each answer part's drawn text, joined by a blank line", () => {
  expect(responseText([{ text: "Yep, all good! Fill me in and I'll get going\n" }, { text: ".\n" }])).toBe("Yep, all good! Fill me in and I'll get going\n\n.")
  expect(responseText([{ text: "Only this." }])).toBe("Only this.")
})
