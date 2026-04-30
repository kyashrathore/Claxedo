import { describe, expect, test } from "vitest"
import { createProcessClient } from "./client"

describe("process client", () => {
  test("start without options omits json content-type for an empty body", async () => {
    let seen:
      | {
          body: RequestInit["body"]
          type: string | null
          dir: string | null
          url: string
        }
      | undefined

    const client = createProcessClient({
      baseUrl: "http://localhost:4096",
      directory: "/tmp/demo",
      fetch: (async (input: any, init: any) => {
        const headers = new Headers(init?.headers)
        seen = {
          body: init?.body,
          type: headers.get("Content-Type"),
          dir: headers.get("x-opencode-directory"),
          url: String(input),
        }
        return new Response(
          JSON.stringify({
            kind: "started",
            process: {
              configId: "proc_1",
              status: "running",
              restartCount: 0,
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        )
      }) as typeof fetch,
    })

    const result = await client.start("proc_1")

    expect(result.kind).toBe("started")
    expect(seen).toBeDefined()
    expect(seen!.body).toBeUndefined()
    expect(seen!.dir).toBe("/tmp/demo")
    expect(seen!.type).toBeNull()
    expect(seen!.url).toContain("/process/proc_1/start?directory=%2Ftmp%2Fdemo")
  })

  test("start with port conflict resolution sends a json body", async () => {
    let seen:
      | {
          body: RequestInit["body"]
          type: string | null
        }
      | undefined

    const client = createProcessClient({
      baseUrl: "http://localhost:4096",
      directory: "/tmp/demo",
      fetch: (async (_: any, init: any) => {
        const headers = new Headers(init?.headers)
        seen = {
          body: init?.body,
          type: headers.get("Content-Type"),
        }
        return new Response(
          JSON.stringify({
            kind: "started",
            process: {
              configId: "proc_1",
              status: "running",
              restartCount: 0,
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        )
      }) as typeof fetch,
    })

    const result = await client.start("proc_1", { portConflict: "pick-new" })

    expect(result.kind).toBe("started")
    expect(seen).toBeDefined()
    expect(JSON.parse(seen!.body as string)).toEqual({ portConflict: "pick-new" })
    expect(seen!.type).toBe("application/json")
  })

  test("start returns port_conflict when the backend responds with 409", async () => {
    const client = createProcessClient({
      baseUrl: "http://localhost:4096",
      directory: "/tmp/demo",
      fetch: (async (_input: any, _init: any) => {
        return new Response(
          JSON.stringify({
            kind: "port_conflict",
            conflict: {
              type: "port-conflict",
              port: 4096,
              processId: "proc_busy",
              processName: "busy-server",
            },
          }),
          {
            status: 409,
            headers: { "Content-Type": "application/json" },
          },
        )
      }) as typeof fetch,
    })

    const result = await client.start("proc_1", { interactive: true })

    expect(result).toEqual({
      kind: "port_conflict",
      conflict: {
        type: "port-conflict",
        port: 4096,
        processId: "proc_busy",
        processName: "busy-server",
      },
    })
  })

  test("includes workspaceId in the request when provided", async () => {
    let seen:
      | {
          workspaceId: string | null
          url: string
        }
      | undefined

    const client = createProcessClient({
      baseUrl: "http://localhost:4096",
      directory: "/tmp/demo",
      workspaceId: "ws_123",
      fetch: (async (input: any, init: any) => {
        const headers = new Headers(init?.headers)
        seen = {
          workspaceId: headers.get("x-workspace-id"),
          url: String(input),
        }
        return new Response(JSON.stringify({ configs: [], processes: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }) as typeof fetch,
    })

    await client.list()

    expect(seen).toEqual({
      workspaceId: "ws_123",
      url: "http://localhost:4096/process?directory=%2Ftmp%2Fdemo&workspaceId=ws_123",
    })
  })
})
