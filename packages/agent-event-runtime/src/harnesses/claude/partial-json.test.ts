import { describe, expect, test } from "bun:test"
import { readPartialJsonRecord } from "./partial-json"

describe("readPartialJsonRecord", () => {
  test("a complete document parses as is", () => {
    expect(readPartialJsonRecord('{"command":"ls","timeout":5}')).toEqual({ command: "ls", timeout: 5 })
  })

  test("a string value cut mid-way is kept as far as it got", () => {
    expect(readPartialJsonRecord('{"command":"git status --sh')).toEqual({ command: "git status --sh" })
    expect(readPartialJsonRecord('{"command":"cd foo && ls","description":"List th')).toEqual({
      command: "cd foo && ls",
      description: "List th",
    })
  })

  test("a member cut before its value is dropped back to the last complete member", () => {
    expect(readPartialJsonRecord('{"command":"ls","desc')).toEqual({ command: "ls" })
    expect(readPartialJsonRecord('{"command":"ls","description"')).toEqual({ command: "ls" })
    expect(readPartialJsonRecord('{"command":"ls","description":')).toEqual({ command: "ls" })
    expect(readPartialJsonRecord('{"command":"ls",')).toEqual({ command: "ls" })
    expect(readPartialJsonRecord('{"command":"ls","timeout":12')).toEqual({ command: "ls" })
    expect(readPartialJsonRecord('{"command":"ls","run_in_background":tru')).toEqual({ command: "ls" })
  })

  test("a dangling escape is dropped with the string closed after it", () => {
    expect(readPartialJsonRecord('{"command":"echo \\"hi\\')).toEqual({ command: 'echo "hi' })
    expect(readPartialJsonRecord('{"command":"printf \\u00')).toEqual({ command: "printf " })
    expect(readPartialJsonRecord('{"command":"a\\nb')).toEqual({ command: "a\nb" })
  })

  test("nested containers close with their parents", () => {
    expect(readPartialJsonRecord('{"edits":[{"old_string":"a","new_string":"b"},{"old_string":"c')).toEqual({
      edits: [{ old_string: "a", new_string: "b" }, { old_string: "c" }],
    })
    expect(readPartialJsonRecord('{"edits":[{"old_string":"a"},{"old')).toEqual({ edits: [{ old_string: "a" }, {}] })
    expect(readPartialJsonRecord('{"paths":["src","te')).toEqual({ paths: ["src", "te"] })
  })

  test("a bare key inside a nested string is not mistaken for a member", () => {
    expect(readPartialJsonRecord('{"command":"echo {\\"a\\":1, ')).toEqual({ command: 'echo {"a":1, ' })
  })

  test("nothing readable yields undefined", () => {
    expect(readPartialJsonRecord("")).toBeUndefined()
    expect(readPartialJsonRecord("{")).toEqual({})
    expect(readPartialJsonRecord('{"co')).toEqual({})
    expect(readPartialJsonRecord('["a"')).toBeUndefined()
  })
})
