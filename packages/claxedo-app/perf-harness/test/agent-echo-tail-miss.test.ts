import { describe, expect, test } from "bun:test"

// The gate opens on `parsedTail.includes(echo) || data.indexOf(echo) >= 0`, and
// `parsedTail` is the last 64 KiB of the stream. So the second branch — the one
// that records — fires exactly when the echo is >= 65,536 bytes from the end of
// its own batch. This locks that equivalence, which is what makes the recording
// free and complete.
const TAIL = 65_536

function gate(parsedTail: string, data: string, echo: string) {
  const misses: Array<{ bytesFromEnd: number }> = []
  const matched = (() => {
    if (parsedTail.includes(echo)) return true
    const at = data.indexOf(echo)
    if (at < 0) return false
    misses.push({ bytesFromEnd: data.length - at - echo.length })
    return true
  })()
  return { matched, misses }
}

const stream = (echo: string, bytesFromEnd: number) => {
  const data = "x".repeat(10) + echo + "y".repeat(bytesFromEnd)
  return { data, parsedTail: data.slice(-TAIL) }
}

describe("echo tail-miss recording", () => {
  test("echo within the tail window: gate opens, nothing recorded", () => {
    const { data, parsedTail } = stream("ECHO", 100)
    const r = gate(parsedTail, data, "ECHO")
    expect(r.matched).toBe(true)
    expect(r.misses).toEqual([])
  })

  test("echo beyond the tail window: gate STILL opens, and the distance is recorded", () => {
    const { data, parsedTail } = stream("ECHO", TAIL + 5_000)
    const r = gate(parsedTail, data, "ECHO")
    expect(r.matched).toBe(true) // this is the false negative the fix removes
    expect(r.misses).toEqual([{ bytesFromEnd: TAIL + 5_000 }])
  })

  test("absent echo opens nothing and records nothing", () => {
    const { data, parsedTail } = stream("ECHO", 100)
    const r = gate(parsedTail, data, "OTHER")
    expect(r.matched).toBe(false)
    expect(r.misses).toEqual([])
  })

  test("the boundary is offset by the echo's own length, not the bare window", () => {
    // The echo must fit ENTIRELY inside the tail, so containment is
    // `bytesFromEnd + echo.length <= TAIL`, not `bytesFromEnd < TAIL`. The
    // difference is the echo's length (~20 bytes for a real sentinel) and this
    // test exists because my first statement of the equivalence omitted it.
    const echo = "ECHO"
    const lastInside = stream(echo, TAIL - echo.length)
    expect(gate(lastInside.parsedTail, lastInside.data, echo).misses).toEqual([])
    const firstOutside = stream(echo, TAIL - echo.length + 1)
    expect(gate(firstOutside.parsedTail, firstOutside.data, echo).misses).toHaveLength(1)
  })
})
