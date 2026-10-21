import { describe, expect, test } from "bun:test"
import { definePluginBackend, PLUGIN_CALLER_HEADER, PluginPlatformError, type PluginPlatformBinding, type PluginPlatformCall } from "./backend"
import { pluginManifestSchema } from "./manifest-schema"

function binding(answer: (call: PluginPlatformCall) => unknown = () => ({ ok: true })) {
  const calls: { call: PluginPlatformCall; handle: string | undefined }[] = []
  const platform: PluginPlatformBinding = {
    object: async () => new Response("object"),
    active: async () => true,
    call: async (call, handle) => {
      calls.push({ call, handle })
      return answer(call) as Awaited<ReturnType<PluginPlatformBinding["call"]>>
    },
  }
  return { platform, calls }
}

describe("definePluginBackend", () => {
  test("hands a request's handlers the platform bound to the request's caller handle", async () => {
    const { platform, calls } = binding((call) => (call.name === "identity.caller" ? { ok: true, value: { orgId: "org_1", origin: "person", userId: "usr_1" } } : { ok: true }))
    const backend = definePluginBackend({
      fetch: async (_request, bound) => Response.json({ caller: await bound.identity.caller(), allowed: await bound.projects.authorize("prj_1", "write") }),
    })
    const response = await backend.fetch(new Request("https://plugin.test/x", { headers: { [PLUGIN_CALLER_HEADER]: "h1" } }), { PLATFORM: platform })
    expect(await response.json()).toEqual({ caller: { orgId: "org_1", origin: "person", userId: "usr_1" } })
    expect(calls).toEqual([
      { call: { name: "identity.caller" }, handle: "h1" },
      { call: { name: "projects.authorize", projectId: "prj_1", access: "write" }, handle: "h1" },
    ])
  })

  test("the sessions client sends each call under the request's handle and answers the platform's value", async () => {
    const session = { sessionId: "ses_1", workspaceId: "ws_1" }
    const origin = { scope: "prj_1", key: "draft-1" }
    const start = {
      origin,
      projectId: "prj_1",
      placement: "local" as const,
      configuration: { harness: { id: "codex", access: "native" as const }, model: { providerID: "openai", modelID: "gpt-5" }, effort: null },
    }
    const { platform, calls } = binding((call) => ({ ok: true, value: call.name === "sessions.start" ? { session } : call.name }))
    const backend = definePluginBackend({
      fetch: async (_request, bound) =>
        Response.json([
          await bound.sessions.harnesses({ projectId: "prj_1", placement: "cloud" }),
          await bound.sessions.preview(start),
          await bound.sessions.start({ ...start, digest: "d" }),
          await bound.sessions.handoff({ origin, session, text: "Go", attachments: [{ key: "a.png" }] }),
          await bound.sessions.abandon({ origin, session }),
          await bound.sessions.state([origin]),
          await bound.sessions.authorizeOpen(session),
        ]),
    })
    const response = await backend.fetch(new Request("https://plugin.test/x", { headers: { [PLUGIN_CALLER_HEADER]: "h1" } }), { PLATFORM: platform })
    expect(await response.json()).toEqual([
      "sessions.harnesses",
      "sessions.preview",
      { session },
      "sessions.handoff",
      "sessions.abandon",
      "sessions.state",
      "sessions.authorizeOpen",
    ])
    expect(calls).toEqual([
      { call: { name: "sessions.harnesses", projectId: "prj_1", placement: "cloud" }, handle: "h1" },
      { call: { name: "sessions.preview", ...start }, handle: "h1" },
      { call: { name: "sessions.start", ...start, digest: "d" }, handle: "h1" },
      { call: { name: "sessions.handoff", origin, session, text: "Go", attachments: [{ key: "a.png" }] }, handle: "h1" },
      { call: { name: "sessions.abandon", origin, session }, handle: "h1" },
      { call: { name: "sessions.state", origins: [origin] }, handle: "h1" },
      { call: { name: "sessions.authorizeOpen", session }, handle: "h1" },
    ])
  })

  test("a refused call throws the platform's status and code", async () => {
    const { platform } = binding(() => ({ ok: false, status: 403, code: "plugin_permission_not_declared", message: "no" }))
    const backend = definePluginBackend({
      fetch: async (_request, bound) => {
        const refused = await bound.blobs.get("a").catch((error: unknown) => error)
        return Response.json(refused instanceof PluginPlatformError ? { status: refused.status, code: refused.code } : {})
      },
    })
    expect(await (await backend.fetch(new Request("https://plugin.test/x"), { PLATFORM: platform })).json()).toEqual({ status: 403, code: "plugin_permission_not_declared" })
  })

  test("a due wake reaches `wake` with its name and payload, and never `fetch`", async () => {
    const { platform } = binding()
    const woken: unknown[] = []
    const backend = definePluginBackend({
      fetch: () => new Response("fetch", { status: 500 }),
      wake: (name, payload) => void woken.push({ name, payload }),
    })
    const response = await backend.fetch(new Request("https://plugin.test/_wake/daily%20digest", { method: "POST", body: JSON.stringify({ n: 1 }) }), { PLATFORM: platform })
    expect(response.status).toBe(204)
    expect(woken).toEqual([{ name: "daily digest", payload: { n: 1 } }])
  })

  test("a tool call reaches `tool` with its name, its arguments and the caller's platform, and its result is the answer", async () => {
    const { platform, calls } = binding(() => ({ ok: true, value: { orgId: "org_1", origin: "agent", userId: "usr_1", sessionId: "ses_1" } }))
    const backend = definePluginBackend({
      fetch: () => new Response("fetch", { status: 500 }),
      tool: async (name, args, bound) => ({ content: [{ type: "text", text: JSON.stringify({ name, args, caller: await bound.identity.caller() }) }] }),
    })
    const response = await backend.fetch(
      new Request("https://plugin.test/_tools/note_list", { method: "POST", headers: { [PLUGIN_CALLER_HEADER]: "h2" }, body: JSON.stringify({ arguments: { limit: 2 } }) }),
      { PLATFORM: platform },
    )
    const result = (await response.json()) as { content: { text: string }[] }
    expect(JSON.parse(result.content[0].text)).toEqual({ name: "note_list", args: { limit: 2 }, caller: { orgId: "org_1", origin: "agent", userId: "usr_1", sessionId: "ses_1" } })
    expect(calls).toEqual([{ call: { name: "identity.caller" }, handle: "h2" }])
  })

  test("a tool call to a backend that serves no tools is answered 404 and never reaches `fetch`", async () => {
    const { platform } = binding()
    const backend = definePluginBackend({ fetch: () => new Response("fetch", { status: 500 }) })
    const response = await backend.fetch(new Request("https://plugin.test/_tools/x", { method: "POST", body: "{}" }), { PLATFORM: platform })
    expect(response.status).toBe(404)
  })
})

describe("a backend's permissions and tools in the manifest", () => {
  const manifest = { id: "notes", name: "Notes", version: "0.1.0", app: "./app.ts" }
  const backend = { entry: "./backend.ts", routes: ["GET /notes"] }

  test("accepts the platform's permissions and a tool group, and refuses anything else", () => {
    expect(pluginManifestSchema.parse({ ...manifest, permissions: ["blobs", "events"] }).permissions).toEqual(["blobs", "events"])
    expect(pluginManifestSchema.safeParse({ ...manifest, permissions: ["filesystem"] }).success).toBe(false)
    expect(pluginManifestSchema.safeParse({ ...manifest, permissions: ["blobs", "blobs"] }).success).toBe(false)
    const tools = { group: { id: "notes", label: "Notes" }, definitions: "./src/tools.ts" }
    expect(pluginManifestSchema.parse({ ...manifest, backend: { ...backend, tools } }).backend?.tools).toEqual(tools)
    expect(pluginManifestSchema.safeParse({ ...manifest, backend: { ...backend, tools: { group: { id: "Notes", label: "x" }, definitions: "./t.ts" } } }).success).toBe(false)
  })

  test("refuses a route under /_, which belongs to the platform", () => {
    for (const route of ["POST /_wake/tick", "GET /_tools/x", "GET /_"]) {
      expect(pluginManifestSchema.safeParse({ ...manifest, backend: { ...backend, routes: [route] } }).success, route).toBe(false)
    }
    expect(pluginManifestSchema.safeParse({ ...manifest, backend: { ...backend, routes: ["GET /notes/_draft"] } }).success).toBe(true)
  })
})
