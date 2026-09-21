import { describe, expect, test } from "bun:test"
import { createProcessClient } from "./client"

function stopClient(answer: () => Response | Promise<Response>) {
  const calls: string[] = []
  const request = (async (input, init) => {
    const req = new Request(input instanceof Request ? input.url : String(input), init)
    calls.push(`${req.method} ${new URL(req.url).pathname}`)
    return await answer()
  }) as typeof fetch
  return {
    calls,
    client: createProcessClient({
      baseUrl: "http://server.test",
      directory: "/workspace",
      fetch: request,
      resolveWorkspaceRuntime: async () => undefined,
    }),
  }
}

describe("stopping a workspace process", () => {
  test("reports the state and the retirement the workspace answered with", async () => {
    const retirement = { leader: "alive", descendants: "owned" }
    const { client, calls } = stopClient(() => Response.json({ state: "unresolved", retirement }))

    await expect(client.stop("proc_1")).resolves.toEqual({ state: "unresolved", retirement })
    expect(calls).toEqual(["POST /api/wr/process/proc_1/stop"])
  })

  test("a proven stop is the only answer that says the process is gone", async () => {
    const { client } = stopClient(() =>
      Response.json({ state: "stopped", retirement: { leader: "exited", descendants: "verified_clear" } }),
    )

    await expect(client.stop("proc_1")).resolves.toMatchObject({ state: "stopped" })
  })

  test.each([
    ["a refused request", () => new Response("", { status: 503 })],
    ["a transport failure", () => { throw new Error("the workspace is unreachable") }],
    ["an answer this client cannot read", () => Response.json(true)],
    ["an unknown state", () => Response.json({ state: "probably" })],
  ])("%s is unresolved with no evidence, never a stop", async (_label, answer) => {
    const { client } = stopClient(answer)

    await expect(client.stop("proc_1")).resolves.toEqual({ state: "unresolved" })
  })
})
