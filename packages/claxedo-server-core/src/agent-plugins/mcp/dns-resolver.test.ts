import { describe, expect, it, vi } from "vitest"
import { dohAddressResolver } from "./dns-resolver"

function doh(answers: { type: number; data: string }[], status = 0) {
  return Response.json({ Status: status, Answer: answers.map((answer) => ({ name: "x", ...answer })) })
}

describe("dohAddressResolver", () => {
  it("collects A and AAAA answers from the DoH endpoint reached by IP literal", async () => {
    const fetch = vi.fn(async (url: string, _init?: RequestInit) =>
      url.includes("type=AAAA") ? doh([{ type: 28, data: "2606:2800:220:1:248:1893:25c8:1946" }]) : doh([{ type: 1, data: "93.184.216.34" }]))
    const resolve = dohAddressResolver(fetch)
    await expect(resolve("mcp.example")).resolves.toEqual(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"])
    for (const [url, init] of fetch.mock.calls) {
      expect(url).toMatch(/^https:\/\/1\.1\.1\.1\/dns-query\?name=mcp\.example&type=(A|AAAA)$/)
      expect(init?.headers).toEqual({ accept: "application/dns-json" })
    }
  })

  it("chases a CNAME-only answer to the target", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.includes("name=alias.example")) return doh([{ type: 5, data: "target.example" }])
      return doh([{ type: 1, data: "93.184.216.34" }])
    })
    const resolve = dohAddressResolver(fetch)
    await expect(resolve("alias.example")).resolves.toEqual(["93.184.216.34"])
    expect(fetch.mock.calls.some(([url]) => url.includes("name=target.example"))).toBe(true)
  })

  it("answers empty on NXDOMAIN, resolver errors, and failed fetches — a refusal upstream", async () => {
    const resolve = dohAddressResolver(vi.fn(async () => doh([], 3)))
    await expect(resolve("gone.example")).resolves.toEqual([])
    const failing = dohAddressResolver(vi.fn(async () => new Response(null, { status: 503 })))
    await expect(failing("down.example")).resolves.toEqual([])
    const throwing = dohAddressResolver(vi.fn(async () => Promise.reject(new Error("network"))))
    await expect(throwing("down.example")).resolves.toEqual([])
  })

  it("caches answers briefly so a candidate walk resolves once", async () => {
    const fetch = vi.fn(async () => doh([{ type: 1, data: "93.184.216.34" }]))
    const resolve = dohAddressResolver(fetch)
    await resolve("mcp.example")
    await resolve("mcp.example")
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
