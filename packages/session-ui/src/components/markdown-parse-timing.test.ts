import { describe, expect, test } from "bun:test"
import { parseMarkdownMeasured, type MarkdownParseMode } from "./markdown-parse-timing"

describe("parseMarkdownMeasured", () => {
  test("closes a synchronous parse span before yielding to the caller", async () => {
    const traces: Array<{ mode: MarkdownParseMode; started: number | undefined }> = []

    const pending = parseMarkdownMeasured({
      parse: () => "<p>ready</p>",
      clock: () => 12,
      trace: (mode, started) => traces.push({ mode, started }),
    })

    expect(traces).toEqual([{ mode: "sync", started: 12 }])
    expect(await pending).toBe("<p>ready</p>")
  })

  test("keeps an asynchronous parser span open until its result settles", async () => {
    let resolve!: (value: string) => void
    const parsed = new Promise<string>((done) => {
      resolve = done
    })
    const traces: Array<{ mode: MarkdownParseMode; started: number | undefined }> = []

    const pending = parseMarkdownMeasured({
      parse: () => parsed,
      clock: () => 24,
      trace: (mode, started) => traces.push({ mode, started }),
    })

    expect(traces).toEqual([])
    resolve("<p>later</p>")
    expect(await pending).toBe("<p>later</p>")
    expect(traces).toEqual([{ mode: "async", started: 24 }])
  })
})
