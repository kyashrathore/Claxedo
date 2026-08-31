import { describe, expect, test } from "bun:test"
import { createServerClient } from "./server-client"

describe("createServerClient", () => {
  test("adds server basic authentication after caller headers", async () => {
    let call: Request | undefined
    const client = createServerClient({
      server: {
        url: "https://server.example",
        username: "alice",
        password: "secret",
      },
      headers: { Authorization: "Bearer ignored", "X-Request": "present" },
      request: async (input, init) => {
        call = new Request(input, init)
        return Response.json({})
      },
    })

    await client.global.config.get()

    expect(call?.headers.get("authorization")).toBe(`Basic ${btoa("alice:secret")}`)
    expect(call?.headers.get("x-request")).toBe("present")
  })

  test("does not invent a username for password-only credentials", async () => {
    let call: Request | undefined
    const client = createServerClient({
      server: { url: "https://server.example", password: "secret" },
      request: async (input, init) => {
        call = new Request(input, init)
        return Response.json({})
      },
    })

    await client.global.config.get()

    expect(call?.headers.get("authorization")).toBe(`Basic ${btoa(":secret")}`)
  })
})
