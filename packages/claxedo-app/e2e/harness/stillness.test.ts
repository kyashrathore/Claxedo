import assert from "node:assert/strict"
import { test } from "node:test"
import { sinceFirstReady, type ScrollEvent, type StillFrame } from "./stillness"

const frame = (at: number, scrollTop: number): StillFrame => ({ at, scrollTop, scrollHeight: 2_000, clientHeight: 500, ready: true, opened: 0 })
const frames = [frame(100, 1_500), frame(116, 1_500), frame(132, 1_500)]
const scrollsAfterFirstPaint = (scrolls: ScrollEvent[]) => sinceFirstReady({ frames, scrolls, reads: [] }).scrolls

test("stillness: the one scroll event before the second frame that reports the first frame's scrollTop is the first frame's own scroll", () => {
  assert.equal(scrollsAfterFirstPaint([{ at: 104, scrollTop: 1_500, framesBefore: 1 }]), 0)
})

test("stillness: the first frame's own scroll is told by the frame it arrived before, not by a clock that can read the second frame's time", () => {
  assert.equal(scrollsAfterFirstPaint([{ at: 116, scrollTop: 1_500, framesBefore: 1 }]), 0)
})

test("stillness: a second such event, one reporting another scrollTop, or one after the second frame each count as a scroll", () => {
  assert.equal(scrollsAfterFirstPaint([{ at: 104, scrollTop: 1_500, framesBefore: 1 }, { at: 108, scrollTop: 1_500, framesBefore: 1 }]), 1)
  assert.equal(scrollsAfterFirstPaint([{ at: 104, scrollTop: 1_480, framesBefore: 1 }]), 1)
  assert.equal(scrollsAfterFirstPaint([{ at: 116, scrollTop: 1_500, framesBefore: 2 }]), 1)
})
