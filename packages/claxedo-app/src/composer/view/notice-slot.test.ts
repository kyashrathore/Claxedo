/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createComposerNoticeChannel, rankedNotices, type ComposerNotice } from "./notice-slot"

const notice = (kind: string, tone: ComposerNotice["tone"], message = kind): ComposerNotice => ({ kind, tone, message })

test("the slot ranks an error over blocking setup over a lifecycle over info, and merges notices of one kind", () => {
  const ranked = rankedNotices([notice("asleep", "info"), notice("waking", "progress"), notice("setup-required", "warning"), notice("failed", "critical"), notice("waking", "progress", "again")])
  expect(ranked.map((item) => item.kind)).toEqual(["failed", "setup-required", "waking", "asleep"])
  expect(ranked.find((item) => item.kind === "waking")?.message).toBe("waking")
})

test("among notices of one tone the latest published leads, and a source that clears its notice leaves the slot", () => {
  createRoot((dispose) => {
    const channel = createComposerNoticeChannel()
    const harness = {}
    const firstSend = {}
    channel.publish(harness, notice("models-failed", "critical"))
    channel.publish(firstSend, notice("first-send", "critical"))
    expect(channel.notices().map((item) => item.kind)).toEqual(["first-send", "models-failed"])
    channel.publish(firstSend, undefined)
    expect(channel.notices().map((item) => item.kind)).toEqual(["models-failed"])
    dispose()
  })
})
