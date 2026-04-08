import { describe, expect, test } from "bun:test"
import { ConfigRoutes } from "./config"

describe("runtime config route", () => {
  test("passes the raw snapshot through to the apply handler", async () => {
    let seen: unknown
    const app = ConfigRoutes(async (snapshot) => {
      seen = snapshot
    })

    const res = await app.request("http://localhost/api/wr/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        mcp: {
          local: {
            type: "stdio",
            command: "node",
            args: ["server.js"],
            disabled: true,
          },
        },
        runner: {
          type: "claude-acp",
          binary: "/tmp/claude-agent-acp",
          model: "claude-sonnet-4-6",
        },
        auth: {
          "claude-acp": "sk-test",
        },
      }),
    })

    expect(res.status).toBe(200)
    expect(seen).toEqual({
      version: 1,
      mcp: {
        local: {
          type: "stdio",
          command: "node",
          args: ["server.js"],
          disabled: true,
        },
      },
      runner: {
        type: "claude-acp",
        binary: "/tmp/claude-agent-acp",
        model: "claude-sonnet-4-6",
      },
      auth: {
        "claude-acp": "sk-test",
      },
    })
  })
})
