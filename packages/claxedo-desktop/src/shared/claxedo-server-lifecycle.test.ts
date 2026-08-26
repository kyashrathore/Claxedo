import { describe, expect, test } from "bun:test"

import {
  claxedoServerReadyMessage,
  parseClaxedoServerReadyMessage,
} from "./claxedo-server-lifecycle"

describe("Claxedo server lifecycle IPC", () => {
  test("round-trips the exact bound port", () => {
    const message = claxedoServerReadyMessage(3210)
    expect(parseClaxedoServerReadyMessage(message)).toEqual({
      type: "claxedo-server-ready",
      port: 3210,
    })
  })

  test("rejects unrelated and malformed child messages", () => {
    expect(parseClaxedoServerReadyMessage({ type: "owner-registered", port: 3210 })).toBeUndefined()
    expect(parseClaxedoServerReadyMessage({
      type: "claxedo-server-ready",
      port: 0,
    })).toBeUndefined()
    expect(parseClaxedoServerReadyMessage({
      type: "claxedo-server-ready",
      port: "3210",
    })).toBeUndefined()
  })
})
