/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId, projectId, sessionId } from "./ids"
import { createSnapshotCoverage } from "./snapshot-coverage"

const ref = { projectId: projectId("prj"), placementId: placementId("ws_1"), sessionId: sessionId("ses_1") }

function coverage() {
  const gaps: unknown[] = []
  const ledger = createSnapshotCoverage((gapped) => gaps.push(gapped))
  ledger.attached(ref)
  return { ledger, gaps }
}

test("snapshot coverage: reads that land before the stream starts are judged when it starts, and a read the stream covers raises nothing", () => {
  const { ledger, gaps } = coverage()
  ledger.reading(ref, "first").landed("feed_1.10")
  ledger.reading(ref, "open").landed("feed_1.11")
  ledger.streamStarted(ref, "feed_1.10")
  expect(gaps).toEqual([])
})

test("snapshot coverage: a read good up to a position before the stream's start is re-read, once however many data miss it", () => {
  const { ledger, gaps } = coverage()
  ledger.reading(ref, "first").landed("feed_1.3")
  ledger.reading(ref, "open").landed("feed_1.4")
  ledger.reading(ref, "queue").landed("feed_1.4")
  ledger.streamStarted(ref, "feed_1.7")
  expect(gaps).toEqual([ref])
  ledger.reading(ref, "first").landed("feed_1.7")
  ledger.reading(ref, "open").landed("feed_1.8")
  ledger.reading(ref, "queue").landed("feed_1.8")
  expect(gaps, "the re-read is sent after the stream started, so it is covered").toEqual([ref])
})

test("snapshot coverage: a read in flight when the stream starts is judged when it lands", () => {
  const { ledger, gaps } = coverage()
  const first = ledger.reading(ref, "first")
  ledger.streamStarted(ref, "feed_1.7")
  expect(gaps).toEqual([])
  first.landed("feed_1.9")
  expect(gaps).toEqual([])
  const open = ledger.reading(ref, "open")
  ledger.streamEnded(ref)
  ledger.streamStarted(ref, "feed_1.20")
  open.landed("feed_1.12")
  expect(gaps, "a read answered by the runtime before the stream reconnected at 20").toEqual([ref])
})

test("snapshot coverage: a position from another feed, or none at all, is never covered, and a stream that answers no position re-reads once per start", () => {
  const { ledger, gaps } = coverage()
  ledger.reading(ref, "first").landed("feed_2.50")
  ledger.streamStarted(ref, "feed_1.1")
  expect(gaps).toEqual([ref])
  ledger.streamEnded(ref)
  ledger.reading(ref, "first").landed(undefined)
  ledger.streamStarted(ref, undefined)
  expect(gaps).toEqual([ref, ref])
  ledger.reading(ref, "first").landed(undefined)
  ledger.reading(ref, "open").landed(undefined)
  expect(gaps, "the reads a gap caused land without a position too, and must not gap again under the same start").toEqual([ref, ref])
})

test("snapshot coverage: a failed read keeps the datum's last position, and reads of a session with no attached stream are not recorded", () => {
  const { ledger, gaps } = coverage()
  ledger.reading(ref, "first").landed("feed_1.9")
  ledger.reading(ref, "first").failed()
  ledger.streamStarted(ref, "feed_1.9")
  expect(gaps).toEqual([])
  ledger.detached(ref)
  ledger.reading(ref, "first").landed("feed_1.1")
  ledger.streamStarted(ref, "feed_1.9")
  expect(gaps).toEqual([])
})
