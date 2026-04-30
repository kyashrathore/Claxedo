import { describe, expect, test } from "vitest"
import { assertNet, sandboxDriver } from "./sandbox"
import type { SandboxNetworkPolicy } from "../network/resolve"

describe("driver-registry", () => {
  test("returns provider capabilities", () => {
    expect(sandboxDriver("daytona").cap.net).toBe("cidr")
    expect(sandboxDriver("vercel").cap.net).toBe("mixed")
    expect(sandboxDriver("cloudflare").cap.net).toBe("host")
  })

  test("rejects rules a cidr-only provider cannot enforce", () => {
    const net: SandboxNetworkPolicy = {
      mode: "restricted",
      hosts: [],
      cidrs: ["10.0.0.1/32"],
      rules: [{ target: "10.0.0.1/32", hosts: [], cidrs: ["10.0.0.1/32"] }],
    }
    expect(() => assertNet("cloudflare", net)).toThrow(/cannot enforce/)
  })
})
