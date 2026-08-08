import { describe, expect, test } from "bun:test"
import { isAuthorizedEngineWorkerRequest, sessionStatusHasActiveWork } from "./claxedo-engine-worker-policy"

describe("engine worker policy", () => {
  test("accepts only the exact per-boot bearer capability", () => {
    expect(isAuthorizedEngineWorkerRequest("Bearer secret", "secret")).toBe(true)
    expect(isAuthorizedEngineWorkerRequest("Bearer other", "secret")).toBe(false)
    expect(isAuthorizedEngineWorkerRequest(undefined, "secret")).toBe(false)
    expect(isAuthorizedEngineWorkerRequest(["Bearer secret"], "secret")).toBe(false)
  })

  test("keeps the worker alive for active or malformed status payloads", () => {
    expect(sessionStatusHasActiveWork({})).toBe(false)
    expect(sessionStatusHasActiveWork({ ses_1: { type: "idle" } })).toBe(false)
    expect(sessionStatusHasActiveWork({ ses_1: { type: "busy" } })).toBe(true)
    expect(sessionStatusHasActiveWork({ ses_1: { type: "retry" } })).toBe(true)
    expect(sessionStatusHasActiveWork(null)).toBe(true)
  })
})
