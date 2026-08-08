import { describe, expect, test } from "vitest"
import {
  dockerSandboxDriverEnabled,
  isSandboxDriverID,
  sandboxDriverCredentialFields,
  sandboxDriverIds,
} from "./index"

describe("sandbox contract", () => {
  test("owns one credential schema for every driver identity", () => {
    expect(sandboxDriverIds).toEqual(["exe", "daytona", "modal", "vercel", "cloudflare", "box", "docker"])
    expect(Object.keys(sandboxDriverCredentialFields).sort()).toEqual([...sandboxDriverIds].sort())
    expect(sandboxDriverCredentialFields.modal.map((field) => field.key)).toEqual(["token_id", "token_secret"])
  })

  test("recognizes only canonical driver identities", () => {
    expect(isSandboxDriverID("daytona")).toBe(true)
    expect(isSandboxDriverID("fetch")).toBe(false)
    expect(isSandboxDriverID(undefined)).toBe(false)
  })

  test("keeps local Docker activation explicit", () => {
    expect(dockerSandboxDriverEnabled({})).toBe(false)
    expect(dockerSandboxDriverEnabled({ CLAXEDO_ENABLE_DOCKER_SANDBOX: "true" })).toBe(true)
    expect(dockerSandboxDriverEnabled({ CLAXEDO_DEV_DOCKER_SANDBOX: "1" })).toBe(true)
  })
})
