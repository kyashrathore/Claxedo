import { describe, expect, it } from "bun:test"
import { isTrustedTourOrigin } from "./tour-origin"

describe("isTrustedTourOrigin", () => {
  it("accepts same-origin messages", () => {
    expect(isTrustedTourOrigin("https://app.claxedo.com", "https://app.claxedo.com")).toBe(true)
  })

  it("accepts the known marketing origins", () => {
    expect(isTrustedTourOrigin("https://claxedo.com", "https://app.claxedo.com")).toBe(true)
    expect(isTrustedTourOrigin("https://www.claxedo.com", "https://app.claxedo.com")).toBe(true)
  })

  it("rejects an arbitrary cross origin (the security bug being fixed)", () => {
    expect(isTrustedTourOrigin("https://evil.example", "https://app.claxedo.com")).toBe(false)
  })

  it("rejects look-alike hosts that merely contain a trusted origin", () => {
    expect(isTrustedTourOrigin("https://claxedo.com.evil.example", "https://app.claxedo.com")).toBe(false)
    expect(isTrustedTourOrigin("https://evilclaxedo.com", "https://app.claxedo.com")).toBe(false)
  })

  it("rejects an empty origin (opaque / file / sandboxed sender)", () => {
    expect(isTrustedTourOrigin("", "https://app.claxedo.com")).toBe(false)
    expect(isTrustedTourOrigin("null", "https://app.claxedo.com")).toBe(false)
  })

  it("trusts a loopback parent only when the app itself is on loopback (local dev)", () => {
    expect(isTrustedTourOrigin("http://localhost:4321", "http://localhost:4444")).toBe(true)
    expect(isTrustedTourOrigin("http://127.0.0.1:4321", "http://localhost:4444")).toBe(true)
    // A production app must NOT trust a loopback sender.
    expect(isTrustedTourOrigin("http://localhost:4321", "https://app.claxedo.com")).toBe(false)
  })
})
