import { describe, expect, test } from "bun:test"
import { RequestError } from "@agentclientprotocol/sdk"
import { errorMessage } from "./helpers"

/**
 * `errorMessage` is what turns a failed ACP RPC into the string the user reads,
 * so the only thing that matters about it is whether the informative half of a
 * JSON-RPC error survives.
 *
 * The trap it exists to avoid: `RequestError` from `@agentclientprotocol/sdk`
 * extends `Error` *and* carries `data`, and its static constructors put the
 * caller's payload in `data` while `message` is the fixed JSON-RPC code name
 * ("Internal error", "Invalid params", ...). An `instanceof Error` check that
 * runs before the `data` check therefore returns the code name for every
 * agent-side failure and never reaches the `data` branch at all — which is how
 * an agent startup failure can otherwise reach the UI only as "Internal error".
 * Agents may place their useful detail in either `data.details` or `data.message`.
 */
describe("errorMessage", () => {
  test("the RequestError premise: it is an Error subclass whose detail lives in .data", () => {
    const err = RequestError.internalError({ details: "boom" })

    // If either of these ever stops holding, the ordering in `errorMessage` is
    // guarding against nothing and the `data` branch can be simplified away.
    expect(err instanceof Error).toBe(true)
    expect(typeof (err as { data?: unknown }).data).toBe("object")
    expect(err.message).toBe("Internal error")
  })

  test("a plain Error keeps its message", () => {
    expect(errorMessage(new Error("spawn ENOENT"))).toBe("spawn ENOENT")
  })

  test("an agent's data.details surfaces instead of only the JSON-RPC code name", () => {
    const stderr = "Agent process exited with code 1. stderr: configuration rejected"

    expect(errorMessage(RequestError.internalError({ details: stderr }))).toBe(`Internal error: ${stderr}`)
  })

  test("agents that put their detail in data.message surface that instead", () => {
    expect(errorMessage({ code: -32603, message: "Internal error", data: { message: "model unavailable" } }))
      .toBe("Internal error: model unavailable")
  })

  test("a top-level message that differs from the detail is composed with it", () => {
    expect(errorMessage({ code: -32602, message: "Invalid params", data: { details: "cwd must be absolute" } }))
      .toBe("Invalid params: cwd must be absolute")
  })

  test("a top-level message equal to the detail is not duplicated", () => {
    expect(errorMessage({ code: -32603, message: "disk full", data: { details: "disk full" } })).toBe("disk full")
  })

  test("a bare JSON-RPC object with no data uses its message", () => {
    expect(errorMessage({ code: -32601, message: "Method not found" })).toBe("Method not found")
  })

  test("a non-object is stringified", () => {
    expect(errorMessage("connection reset")).toBe("connection reset")
    expect(errorMessage(null)).toBe("null")
    expect(errorMessage(undefined)).toBe("undefined")
  })
})
