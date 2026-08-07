import { describe, expect, test } from "bun:test"
import { documentsAccess } from "@/app/integrations/optional-feature-access"

describe("documentsAccess", () => {
  test("allows trusted unsigned loopback Documents", () => {
    expect(documentsAccess({ principal: { kind: "anonymous" }, serverUrl: "http://127.0.0.1:4096" })).toBe(true)
    expect(documentsAccess({ principal: { kind: "anonymous" }, serverUrl: "http://localhost:4096" })).toBe(true)
    expect(documentsAccess({ principal: { kind: "anonymous" }, serverUrl: "http://[::1]:4096" })).toBe(true)
  })

  test("allows authenticated identities on hosted and local servers", () => {
    expect(
      documentsAccess({
        principal: { kind: "signed", userId: "user_1", getToken: async () => null },
        serverUrl: "https://control.example.test",
      }),
    ).toBe(true)
    expect(
      documentsAccess({ principal: { kind: "local", deviceId: "device_1" }, serverUrl: "https://desktop.invalid" }),
    ).toBe(true)
  })

  test("rejects an anonymous non-loopback browser", () => {
    expect(documentsAccess({ principal: { kind: "anonymous" }, serverUrl: "https://control.example.test" })).toBe(false)
    expect(documentsAccess({ principal: { kind: "anonymous" }, serverUrl: undefined })).toBe(false)
  })
})
