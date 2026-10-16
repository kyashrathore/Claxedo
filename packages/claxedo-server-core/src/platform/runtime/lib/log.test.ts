import { afterEach, expect, test, vi } from "vitest"
import { setOperatorLogSink } from "@claxedo/helpers/operator-log"
import { Log } from "./log"

afterEach(() => setOperatorLogSink(undefined))

test("warnings and errors also reach the operator log, and info lines stay on stderr alone", () => {
  const operator: string[] = []
  setOperatorLogSink((line) => operator.push(line))
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  try {
    const log = Log.create({ service: "cloud-session-rows" })
    log.info("turn text", { text: "the person's prompt" })
    log.warn("pass lapsed")
    log.error("renewal failed", { status: 502 })
    expect(stderr).toHaveBeenCalledTimes(3)
  } finally {
    stderr.mockRestore()
  }
  expect(operator).toEqual([
    expect.stringMatching(/^\S+ WARN  pass lapsed service=cloud-session-rows\n$/),
    expect.stringMatching(/^\S+ ERROR renewal failed service=cloud-session-rows status=502\n$/),
  ])
})
