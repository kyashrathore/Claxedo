/// <reference types="bun" />
import { expect, test } from "bun:test"
import { queuedMessageStatus } from "./queued-message-status"
import type { QueuedMessage, TimelineTextKey } from "./model"

const t = (key: TimelineTextKey) => key
const item = (steering?: QueuedMessage["steering"]): QueuedMessage => ({ seq: 1, queuedAt: 1, parts: [], held: false, ...(steering ? { steering } : {}) })
const steer = (state: NonNullable<QueuedMessage["steering"]>["state"], message?: string) => item({ mode: "steer", operationId: "op", state, ...(message ? { message } : {}) })

test("a steer the harness declined says so, gives the reason, and offers a retry", () => {
  expect(queuedMessageStatus(steer("rejected", "Claude refused the steer before taking it in"), false, t)).toEqual({
    label: "ui.message.queued.declined", reason: "Claude refused the steer before taking it in", send: "ui.message.queued.retry",
  })
  expect(queuedMessageStatus(steer("rejected"), false, t)).toEqual({ label: "ui.message.queued.declined", send: "ui.message.queued.retry" })
})

test("every other queued message keeps its label and sends now", () => {
  expect(queuedMessageStatus(item(), false, t)).toEqual({ label: "ui.message.queued", send: "ui.message.queued.sendNow" })
  expect(queuedMessageStatus(item(), true, t)).toEqual({ label: "ui.message.queued.editing", send: "ui.message.queued.sendNow" })
  expect(queuedMessageStatus(steer("accepted"), false, t).label).toBe("ui.message.queued.accepted")
  expect(queuedMessageStatus(steer("dispatching"), false, t).label).toBe("ui.message.queued.dispatching")
  expect(queuedMessageStatus(steer("unknown"), false, t).label).toBe("ui.message.queued.unknown")
})
