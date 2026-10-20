/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { surfaceActionPrompt, surfaceReplyTransition, type SurfaceReplyState } from "./surface-reply-action"

describe("surfaceActionPrompt", () => {
  test("names the surface and the action on one line, then the context as compact JSON", () => {
    const prompt = surfaceActionPrompt("Deploy settings", { name: "save", surfaceId: "call-1", sourceComponentId: "save", timestamp: "t", context: { name: "api", regions: ["eu"] } })
    expect(prompt).toBe('Surface action "save" on "Deploy settings": {"name":"api","regions":["eu"]}')
  })

  test("quotes a title or action name that carries quotes", () => {
    const prompt = surfaceActionPrompt('Say "hi"', { name: "go", surfaceId: "s", sourceComponentId: "b", timestamp: "t", context: {} })
    expect(prompt).toBe('Surface action "go" on "Say \\"hi\\"": {}')
  })
})

describe("surfaceReplyTransition", () => {
  const idle: SurfaceReplyState = { kind: "idle" }

  test("a send settles back to idle, or to its failure", () => {
    const sending = surfaceReplyTransition(idle, { type: "started" })
    expect(sending).toEqual({ kind: "sending" })
    expect(surfaceReplyTransition(sending, { type: "sent" })).toEqual(idle)
    expect(surfaceReplyTransition(sending, { type: "failed", message: "Offline" })).toEqual({ kind: "failed", message: "Offline" })
  })

  test("a result with no send in flight changes nothing, and a new send clears a failure", () => {
    const failed: SurfaceReplyState = { kind: "failed", message: "Offline" }
    expect(surfaceReplyTransition(idle, { type: "failed", message: "late" })).toBe(idle)
    expect(surfaceReplyTransition(failed, { type: "sent" })).toBe(failed)
    expect(surfaceReplyTransition(failed, { type: "started" })).toEqual({ kind: "sending" })
  })
})
