import { describe, expect, test } from "bun:test"
import { isQuestionDeclined } from "./question-result"

describe("isQuestionDeclined", () => {
  test("reads the decline the harness recorded on the part", () => {
    expect(isQuestionDeclined({ question: { declined: true } })).toBe(true)
  })

  test("a question error with no decline recorded is a failure", () => {
    expect(isQuestionDeclined({ question: {} })).toBe(false)
    expect(isQuestionDeclined({})).toBe(false)
  })

  test("does not accept a truthy stand-in for the flag", () => {
    expect(isQuestionDeclined({ question: { declined: "yes" } })).toBe(false)
  })

  test("survives a metadata value that is not a record", () => {
    expect(isQuestionDeclined({ question: "User dismissed the question" })).toBe(false)
  })
})
