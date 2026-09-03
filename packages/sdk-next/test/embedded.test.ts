import { describe, expect, test, vi } from "bun:test"
import { createEmbeddedHost, type EmbeddedModule } from "../src/embedded"

describe("SDK-next embedded OpenCode host", () => {
  test("serves every request through one in-process handler", async () => {
    const fetch = vi.fn(async (request: Request) => Response.json({ path: new URL(request.url).pathname }))
    const disposeAllInstances = vi.fn(async () => {})
    const host = await createEmbeddedHost({
      load: async () =>
        ({
          Server: { Default: () => ({ app: { fetch } }) },
          InstanceRuntime: { disposeAllInstances },
        }) as unknown as EmbeddedModule,
    })

    const response = await host.fetch(new Request("http://opencode.internal/session"))

    expect(await response.json()).toEqual({ path: "/session" })
    expect(fetch).toHaveBeenCalledTimes(1)
    await host.dispose()
    expect(disposeAllInstances).toHaveBeenCalledTimes(1)
  })

  test("registers application tools before the first request and releases the host once", async () => {
    const order: string[] = []
    const disposeTools = vi.fn(async () => {
      order.push("dispose-tools")
    })
    const disposeAllInstances = vi.fn(async () => {
      order.push("dispose-engine")
    })
    const host = await createEmbeddedHost({
      load: async () =>
        ({
          ApplicationToolRuntime: {
            register: async (tools: Record<string, unknown>) => {
              order.push(`register:${Object.keys(tools).join(",")}`)
              return disposeTools
            },
          },
          Server: {
            Default: () => ({
              app: {
                fetch: async () => {
                  order.push("request")
                  return Response.json({ ok: true })
                },
              },
            }),
          },
          InstanceRuntime: { disposeAllInstances },
        }) as EmbeddedModule,
      applicationTools: async () => ({
        app_create_stream: {
          description: "Create a stream",
          inputSchema: { type: "object" },
          execute: async () => ({ ok: true }),
        },
      }),
    })

    await host.fetch(new Request("http://opencode.internal/session"))
    await host.dispose()
    await host.dispose()

    expect(order).toEqual([
      "register:app_create_stream",
      "request",
      "dispose-tools",
      "dispose-engine",
    ])
  })

  test("drains the engine even when application-tool disposal fails", async () => {
    const disposeAllInstances = vi.fn(async () => {})
    const host = await createEmbeddedHost({
      load: async () =>
        ({
          ApplicationToolRuntime: {
            register: async () => async () => {
              throw new Error("tool cleanup failed")
            },
          },
          Server: { Default: () => ({ app: { fetch: async () => Response.json({ ok: true }) } }) },
          InstanceRuntime: { disposeAllInstances },
        }) as EmbeddedModule,
      applicationTools: async () => ({}),
    })

    await expect(host.dispose()).rejects.toThrow("Embedded OpenCode disposal failed")
    expect(disposeAllInstances).toHaveBeenCalledTimes(1)
  })
})
