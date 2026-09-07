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

    await client.path.get()

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

    await client.path.get()

    expect(call?.headers.get("authorization")).toBe(`Basic ${btoa(":secret")}`)
  })

  test("answers server routes and runtime routes from the one server URL with the one scope", async () => {
    const calls: string[] = []
    const client = createServerClient({
      server: { url: "https://server.example/" },
      directory: "/repo",
      request: async (input, init) => {
        calls.push(new Request(input, init).url)
        return Response.json([])
      },
    })

    await client.project.list()
    await client.session.list()

    expect(calls).toEqual([
      "https://server.example/project?directory=%2Frepo",
      "https://server.example/session?directory=%2Frepo",
    ])
  })
})
