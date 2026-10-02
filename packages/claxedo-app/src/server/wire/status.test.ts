/// <reference types="bun" />
import { expect, test } from "bun:test"
import { sessionStatusFromWire } from "./status"

test("a retry reads as retrying, with its attempt and countdown when the harness reported them", () => {
  expect(sessionStatusFromWire({ type: "retry", message: "The model request failed (rate_limit, HTTP 429); retry 1 of 10", attempt: 1, next: 6_000 }))
    .toEqual({ kind: "retrying", message: "The model request failed (rate_limit, HTTP 429); retry 1 of 10", attempt: 1, nextAt: 6_000 })
})

test("a retry without an attempt or a countdown still reads as retrying", () => {
  expect(sessionStatusFromWire({ type: "retry", message: "Reconnecting... 2/5" })).toEqual({ kind: "retrying", message: "Reconnecting... 2/5" })
})

test("a retry without its message is not a status", () => {
  expect(sessionStatusFromWire({ type: "retry", attempt: 1, next: 6_000 })).toBeUndefined()
})

test("an interrupted session retains its reason and never reads as active recovery", () => {
  expect(sessionStatusFromWire({ type: "interrupted", message: "Runtime restarted" })).toEqual({ kind: "interrupted", message: "Runtime restarted" })
  expect(sessionStatusFromWire({ type: "interrupted" })).toBeUndefined()
})
