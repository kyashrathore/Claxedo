import { describe, expect, test } from "bun:test"
import { newProjectFlow } from "./new-project-flow"

describe("newProjectFlow", () => {
  test("a filesystem server without accounts is a folder, signed in or not", () => {
    expect(newProjectFlow({ localExecution: true, signed: false })).toBe("folder")
  })

  test("a filesystem server with a signed account offers both", () => {
    expect(newProjectFlow({ localExecution: true, signed: true })).toBe("choose")
  })

  test("a server with no filesystem is cloud only", () => {
    expect(newProjectFlow({ localExecution: false, signed: true })).toBe("cloud")
    expect(newProjectFlow({ localExecution: false, signed: false })).toBe("cloud")
  })

  test("a server that says nothing about its filesystem falls back to the product its mode has always been", () => {
    expect(newProjectFlow({ localExecution: undefined, signed: false })).toBe("folder")
    expect(newProjectFlow({ localExecution: undefined, signed: true })).toBe("cloud")
  })
})
