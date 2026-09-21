import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { createWorkspaceHost } from "./runtime"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import { withWorkspaceTarget } from "../target"

test("public remote ACP disconnect preserves received output and never replays the uncertain prompt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-acp-websocket-"))
  const target = { workspaceId: "websocket-workspace", directory }
  const log: Array<{ method?: string; params?: { sessionId?: string; prompt?: unknown } }> = []
  let connections = 0
  let prompts = 0
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response("WebSocket required", { status: 426 }) },
    websocket: {
      open() { connections++ },
      message(ws, data) {
        const message = JSON.parse(String(data))
        log.push(message)
        const send = (body: unknown) => ws.send(JSON.stringify({ jsonrpc: "2.0", ...body as object }))
        if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } } })
        else if (message.method === "session/new") send({ id: message.id, result: { sessionId: "remote-persistent-session" } })
        else if (message.method === "session/resume") send({ id: message.id, result: {} })
        else if (message.method === "session/prompt") {
          prompts++
          send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: prompts === 1 ? "Output received before connection loss." : "Explicit continuation completed." } } } })
          if (prompts === 1) ws.close(1011, "simulated response loss")
          else send({ id: message.id, result: { stopReason: "end_turn" } })
        } else if (message.method && message.id !== undefined) send({ id: message.id, result: {} })
      },
    },
  })
  const host = createWorkspaceHost({ target, storeRoot: join(directory, "store") })
  const app = new Hono()
  host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
  const request = (pathname: string, method = "GET", body?: unknown) => withWorkspaceTarget(target, () => app.request(
    `http://runtime.test${pathname}?directory=${encodeURIComponent(directory)}`,
    { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) },
  ))
  try {
    await host.apply({ version: 4, auth: {}, mcp: {}, connections: [{ connectionId: "remote", providerKey: "acp", configRevision: 1, enabled: true, config: { label: "Remote acceptance", connection: { kind: "websocket", url: `ws://127.0.0.1:${server.port}` } } }], defaultHarness: { kind: "connection", connectionId: "remote" } })
    expect((await request("/session", "POST", { id: "remote-local", title: "Remote acceptance" })).status).toBe(201)
    expect(await (await request("/session/remote-local")).json()).toMatchObject({ title: "Remote acceptance", titleSource: "user" })
    const failed = await request("/session/remote-local/message", "POST", { parts: [{ type: "text", text: "First operation; do not repeat." }] })
    await failed.text()
    const history = JSON.stringify(await (await request("/session/remote-local/message")).json())
    expect(history).toContain("Output received before connection loss.")
    expect(history).toContain("uncertain")
    expect(prompts).toBe(1)
    expect(connections).toBe(1)
    expect(host.detail().connectionState?.state).toBe("disconnected")
    const continued = await request("/session/remote-local/message", "POST", { parts: [{ type: "text", text: "Inspect state and continue explicitly." }] })
    await continued.text()
    expect(prompts).toBe(2)
    expect(connections).toBe(2)
    expect(log.filter(row => row.method === "session/new")).toHaveLength(1)
    expect(log.filter(row => row.method === "session/resume")).toMatchObject([{ params: { sessionId: "remote-persistent-session" } }])
    const submitted = log.filter(row => row.method === "session/prompt")
    expect(JSON.stringify(submitted[1]?.params?.prompt)).not.toContain("First operation; do not repeat.")
    const messages = await (await request("/session/remote-local/message")).json() as Array<{ info: Record<string, unknown> }>
    for (const { info } of messages) {
      expect(info).not.toHaveProperty("model")
      expect(info).not.toHaveProperty("modelID")
      expect(info).not.toHaveProperty("providerID")
    }
    expect(log.some(row => row.method === "session/set_model" || row.method === "session/set_config_option")).toBe(false)
    const restored = JSON.stringify(messages)
    expect(restored).toContain("Output received before connection loss.")
    expect(restored).toContain("Explicit continuation completed.")
  } finally { await host.dispose(); server.stop(true); await rm(directory, { recursive: true, force: true }) }
})

for (const imageSupport of [true, false]) test(`public remote ACP image delivery honors negotiated capability (${imageSupport})`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-acp-image-"))
  const target = { workspaceId: "image-workspace", directory }
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP9sAAAAASUVORK5CYII="
  const submitted: Array<{ sessionId: string; prompt: unknown[] }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response("WebSocket required", { status: 426 }) },
    websocket: { message(ws, data) {
      const message = JSON.parse(String(data))
      const send = (body: object) => ws.send(JSON.stringify({ jsonrpc: "2.0", ...body }))
      if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: imageSupport } } } })
      else if (message.method === "session/new") send({ id: message.id, result: { sessionId: "remote-image-session" } })
      else if (message.method === "session/prompt") {
        submitted.push(message.params)
        send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Image received." } } } })
        send({ id: message.id, result: { stopReason: "end_turn" } })
      } else if (message.method && message.id !== undefined) send({ id: message.id, result: {} })
    } },
  })
  const host = createWorkspaceHost({ target, storeRoot: join(directory, "store") })
  const app = new Hono()
  host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
  const request = (pathname: string, method = "GET", body?: unknown) => withWorkspaceTarget(target, () => app.request(
    `http://runtime.test${pathname}?directory=${encodeURIComponent(directory)}`,
    { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) },
  ))
  try {
    await host.apply({ version: 4, auth: {}, mcp: {}, connections: [{ connectionId: "images", providerKey: "acp", configRevision: 1, enabled: true, config: { label: "Image peer", connection: { kind: "websocket", url: `ws://127.0.0.1:${server.port}` } } }], defaultHarness: { kind: "connection", connectionId: "images" } })
    expect((await request("/session", "POST", { id: "image-local", title: "Image acceptance" })).status).toBe(201)
    const response = await request("/session/image-local/message", "POST", { parts: [
      { type: "text", text: "Review this attachment." },
      { type: "file", filename: "pixel.png", mime: "image/png", url: `data:image/png;base64,${png}` },
    ] })
    await response.text()
    const history = JSON.stringify(await (await request("/session/image-local/message")).json())
    if (imageSupport) {
      expect(submitted).toHaveLength(1)
      expect(submitted[0]!.prompt).toContainEqual({ type: "image", mimeType: "image/png", data: png })
      expect(JSON.stringify(submitted)).not.toContain(directory)
      expect(JSON.stringify(submitted)).not.toContain("file:")
      expect(history).toContain("Image received.")
    } else {
      expect(submitted).toEqual([])
      expect(history).toContain("image/png")
      expect(history).not.toContain("Image received.")
    }
  } finally { await host.dispose(); server.stop(true); await rm(directory, { recursive: true, force: true }) }
})
