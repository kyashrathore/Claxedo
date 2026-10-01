import { expect, test } from "bun:test"
import type { OutsideTurnEvent } from "./broker"
import { TransportError } from "./errors"
import { HarnessVersionGate, harnessVersionStanding, type HarnessVersionRange } from "./harness-version"

const range: HarnessVersionRange = { transport: "claude", program: "Fixture CLI", min: "2.1.280", max: "2.1.285" }

function publishing() {
  const published: OutsideTurnEvent[] = []
  return { published, broker: { publish: async (event: OutsideTurnEvent) => { published.push(event) } } }
}

function failure(run: () => unknown): TransportError {
  try { run() } catch (error) {
    expect(error).toBeInstanceOf(TransportError)
    return error as TransportError
  }
  throw new Error("expected a TransportError")
}

test("both ends of a range and every version between them are tested", () => {
  for (const version of ["2.1.280", "2.1.283", "2.1.285"]) expect(harnessVersionStanding(range, version)).toBe("tested")
})

test("a version older than the range is a configuration error naming the installed and minimum versions", () => {
  for (const version of ["2.1.279", "2.1.28", "2.0.999", "1.9.999"]) {
    const error = failure(() => harnessVersionStanding(range, version))
    expect(error).toMatchObject({ transport: "claude", code: "configuration", retryable: false, detail: { installed: version, minimum: "2.1.280" } })
    expect(error.message).toBe(`Fixture CLI ${version} is installed, and Claxedo needs Fixture CLI 2.1.280 or newer. Update Fixture CLI, then send the message again.`)
  }
})

test("a version newer than the range compares by number, not by text", () => {
  for (const version of ["2.1.286", "2.1.1000", "2.10.0", "3.0.0"]) expect(harnessVersionStanding(range, version)).toBe("newer")
})

test("a version that is missing or unreadable is a protocol error, never a pass", () => {
  for (const version of [undefined, "", "2.1", "2.1.285-beta.1", "v2.1.285", "2.1.285 (Claude Code)", 2.1]) {
    expect(failure(() => harnessVersionStanding(range, version))).toMatchObject({ transport: "claude", code: "protocol", retryable: false })
  }
})

test("a gate reports a newer version once, whichever session meets it first", async () => {
  const gate = new HarnessVersionGate(range, "fixture.source")
  const first = publishing()
  const second = publishing()
  await gate.admit("2.1.285", "fixture/init", first.broker)
  expect(first.published).toEqual([])
  await gate.admit("2.1.286", "fixture/init", first.broker)
  await gate.admit("2.1.286", "fixture/init", first.broker)
  await gate.admit("3.0.0", "fixture/init", second.broker)
  expect(first.published).toEqual([{ type: "diagnostic", diagnostic: { code: "claude.untested_version", severity: "warn", source: "fixture.source",
    method: "fixture/init", message: "Fixture CLI 2.1.286 is newer than 2.1.285, the newest version Claxedo is tested against" } }])
  expect(second.published).toEqual([])
})

test("a gate rejects a version that is too old or missing and publishes nothing", async () => {
  const gate = new HarnessVersionGate(range, "fixture.source")
  const { broker, published } = publishing()
  await expect(gate.admit("2.1.279", "fixture/init", broker)).rejects.toMatchObject({ code: "configuration" })
  await expect(gate.admit(undefined, "fixture/init", broker)).rejects.toMatchObject({ code: "protocol" })
  expect(published).toEqual([])
})
