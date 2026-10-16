import { afterEach, expect, spyOn, test } from "bun:test"
import { setOperatorLogSink } from "@claxedo/helpers/operator-log"
import { Log } from "./log"

afterEach(() => setOperatorLogSink(undefined))

test("the runtime's warnings and errors also reach the operator log, and its info lines stay on stderr alone", () => {
  const operator: string[] = []
  setOperatorLogSink((line) => operator.push(line))
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
  try {
    const log = Log.create({ service: "pty" })
    log.info("prompt received", { text: "the person's prompt" })
    log.warn("spawn slow", { ms: 5 })
    log.error("spawn failed")
    expect(stderr).toHaveBeenCalledTimes(3)
  } finally {
    stderr.mockRestore()
  }
  expect(operator).toEqual([
    expect.stringMatching(/^\S+ WARN  spawn slow service=pty ms=5\n$/),
    expect.stringMatching(/^\S+ ERROR spawn failed service=pty\n$/),
  ])
})
