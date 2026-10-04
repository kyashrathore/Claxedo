import { describe, expect, test } from "vitest"
import { allowedOriginPatterns } from "./cors-origins"

function allowed(origin: string, configured?: string) {
  return allowedOriginPatterns(configured).some((pattern) => pattern.test(origin))
}

describe("allowed origin suffixes", () => {
  test("allows the configured HTTPS domain and its subdomains", () => {
    expect(allowed("https://claxedo.com")).toBe(true)
    expect(allowed("https://app.claxedo.com")).toBe(true)
    expect(allowed("http://app.claxedo.com")).toBe(false)
    expect(allowed("https://notclaxedo.com")).toBe(false)
  })

  test("treats regex metacharacters as literal suffix text", () => {
    expect(allowed("https://evil.com", "claxedo.com|evil.com")).toBe(false)
    expect(allowed("https://claxedo.com", "claxedo.com|evil.com")).toBe(false)
  })
})
