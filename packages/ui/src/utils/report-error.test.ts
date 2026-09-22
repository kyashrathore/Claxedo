import { afterEach, describe, expect, test } from "bun:test"
import { reportUiError, setUiErrorReporter } from "./report-error"

afterEach(() => setUiErrorReporter(undefined))

describe("reportUiError", () => {
  test("forwards the error and its source to the installed reporter", () => {
    const seen: Array<[unknown, { source: string }]> = []
    setUiErrorReporter((error, context) => seen.push([error, context]))
    const error = new Error("sprite missing")

    reportUiError(error, "svg-sprite:file-icon-sprite")

    expect(seen).toEqual([[error, { source: "svg-sprite:file-icon-sprite" }]])
  })

  test("drops the error when no reporter is installed", () => {
    expect(() => reportUiError(new Error("nobody listening"), "theme")).not.toThrow()
  })
})
