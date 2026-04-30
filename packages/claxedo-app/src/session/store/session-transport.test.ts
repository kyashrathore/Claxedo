import { beforeEach, describe, expect, mock, test } from "bun:test"

const calls: Array<{ url: string; method?: string }> = []

mock.module("../../utils/api", () => ({
  authFetch: async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    calls.push({
      url: request.url,
      method: request.method,
    })
    return new Response(JSON.stringify([{ info: { id: "msg_1", role: "user" } }]), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "x-next-cursor": "cursor_1",
      },
    })
  },
  getClaxedoServerUrl: () => "http://test.local",
}))

const {
  fetchSessionByTransport,
  fetchSessionMessagesByTransport,
  fetchSessionTodoByTransport,
  usesClaxedoSessionTransport,
} = await import("./session-transport")

beforeEach(() => {
  calls.length = 0
})

describe("session transport split", () => {
  test("treats ses-prefixed ids as upstream sessions", () => {
    expect(usesClaxedoSessionTransport("ses_123")).toBe(false)
    expect(usesClaxedoSessionTransport("ses_local")).toBe(false)
  })

  test("routes non-ses ids through claxedo-server", () => {
    expect(usesClaxedoSessionTransport("0251fd86-2f35-4efe-a802-b2fd6d473992")).toBe(true)
    expect(usesClaxedoSessionTransport("3aca2eef-6d50-4366-9600-a7ebb9852a58")).toBe(true)
  })

  test("uses upstream client for ses-prefixed message reads", async () => {
    const client = {
      get: mock(async () => ({ data: { id: "ses_123" } })),
      messages: mock(async () => ({ data: [], response: new Response(null) })),
      todo: mock(async () => ({ data: [] })),
    }

    await fetchSessionMessagesByTransport({
      client,
      directory: "/repo",
      sessionID: "ses_123",
      limit: 8,
    })

    expect(client.messages).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(0)
  })

  test("uses claxedo-server for uuid message reads", async () => {
    const client = {
      get: mock(async () => ({ data: { id: "ses_123" } })),
      messages: mock(async () => ({ data: [], response: new Response(null) })),
      todo: mock(async () => ({ data: [] })),
    }

    const result = await fetchSessionMessagesByTransport({
      client,
      directory: "/repo",
      sessionID: "0251fd86-2f35-4efe-a802-b2fd6d473992",
      limit: 8,
      before: "cursor_0",
    })

    expect(client.messages).toHaveBeenCalledTimes(0)
    expect(calls).toEqual([
      {
        url: "http://test.local/session/0251fd86-2f35-4efe-a802-b2fd6d473992/message?directory=%2Frepo&limit=8&before=cursor_0",
        method: "GET",
      },
    ])
    expect(result.data?.[0]?.info?.id).toBe("msg_1")
    expect(result.response.headers.get("x-next-cursor")).toBe("cursor_1")
  })

  test("uses claxedo-server for uuid session and todo reads", async () => {
    const client = {
      get: mock(async () => ({ data: { id: "ses_123" } })),
      messages: mock(async () => ({ data: [], response: new Response(null) })),
      todo: mock(async () => ({ data: [] })),
    }

    await fetchSessionByTransport({
      client,
      directory: "/repo",
      sessionID: "3aca2eef-6d50-4366-9600-a7ebb9852a58",
    })
    await fetchSessionTodoByTransport({
      client,
      directory: "/repo",
      sessionID: "3aca2eef-6d50-4366-9600-a7ebb9852a58",
    })

    expect(client.get).toHaveBeenCalledTimes(0)
    expect(client.todo).toHaveBeenCalledTimes(0)
    expect(calls.map((item) => item.url)).toEqual([
      "http://test.local/session/3aca2eef-6d50-4366-9600-a7ebb9852a58?directory=%2Frepo",
      "http://test.local/session/3aca2eef-6d50-4366-9600-a7ebb9852a58/todo?directory=%2Frepo",
    ])
  })
})
