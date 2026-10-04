import { describe, expect, test } from "bun:test"
import { privateWriteEnding } from "./windows-private-file"

/**
 * Runs everywhere, because the defect it locks is not a Windows one: a runner
 * that stops without publishing used to resolve as a success whenever it
 * unwound cleanly, which is exactly what it does when a broken pipe truncates
 * the payload. The caller was told its credential had been written.
 */
describe("what a finished runner is taken to have done", () => {
  const ending = { code: 0, published: true, diagnostics: "" }

  test("only a confirmed publication with a clean exit is a success", () => {
    expect(privateWriteEnding(ending)).toBeUndefined()
  })

  test("a clean exit without the confirmation is a failure, not a success", () => {
    expect(privateWriteEnding({ ...ending, published: false })).toEqual({
      failure: "the runner stopped without publishing the file",
    })
  })

  test("a truncated payload names the delivery, not the exit", () => {
    expect(privateWriteEnding({ ...ending, published: false, transportFailure: "EPIPE" })).toEqual({
      failure: "the payload could not be delivered: EPIPE",
    })
  })

  test("a cancellation surfaces the caller's own failure, not the runner's complaint", () => {
    const failure = new Error("the caller refused to continue")
    expect(
      privateWriteEnding({
        code: 1,
        published: false,
        cancellation: { failure },
        diagnostics: "the caller cancelled the write",
      }),
    ).toEqual({ failure })
  })

  test("a confirmed publication that still exited non-zero is not trusted", () => {
    expect(privateWriteEnding({ ...ending, code: 1, diagnostics: "the file could not be put in place" })).toEqual({
      failure: "the file could not be put in place",
    })
  })

  test("a runner killed without saying anything reports its exit", () => {
    expect(privateWriteEnding({ code: null, published: false, diagnostics: "" })).toEqual({
      failure: "the runner exited with null",
    })
  })
})
