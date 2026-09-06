import { describe, expect, test } from "bun:test"
import { resolveSessionUrl } from "./session-url"
import { requestUrl } from "@/lib/url"

describe("upstream contract", () => {
  test("keeps upstream behavior by leaving local sessions on the current SDK URL", async () => {
    const calls: string[] = []

    await expect(resolveSessionUrl("session-1", {
      cloudAutoSwitch: false,
      claxedoServerUrl: "https://control.example.com",
      fetch: async (input) => {
        calls.push(requestUrl(input))
        return new Response("{}")
      },
    })).resolves.toBeNull()

    expect(calls).toEqual([])
  })

  test("INTENTIONAL DIVERGENCE: upstream would keep the session on the route server, Claxedo resolves a hosted runtime URL first", async () => {
    const calls: string[] = []

    await expect(resolveSessionUrl("session/with slash", {
      claxedoServerUrl: "https://control.example.com/",
      fetch: async (input) => {
        calls.push(requestUrl(input))
        return Response.json({ gatewayUrl: "https://runtime.example.com/" })
      },
    })).resolves.toBe("https://runtime.example.com")

    expect(calls).toEqual(["https://control.example.com/api/control/sessions/session%2Fwith%20slash/gateway"])
  })
})

describe("Claxedo behavior", () => {
  test("keeps session URL resolution independent from RuntimeGateway transport helpers", async () => {
    expect(await Bun.file(new URL("./session-url.ts", import.meta.url)).text()).not.toContain("RuntimeGateway")
  })


})
