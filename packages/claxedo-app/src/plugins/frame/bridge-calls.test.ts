import { describe, expect, test } from "bun:test"
import type { PluginApi } from "@claxedo/plugin-api"
import { createHostPort } from "./host-port"
import type { FrameMirror } from "./protocol"
import { frameBodyEncoding } from "./response-body"
import { createFrameApi } from "./runtime/api"
import { createFrameLink } from "./runtime/link"

const MIRROR: FrameMirror = { locale: "en", projects: [], currentProjectId: undefined, currentSession: undefined, tabs: [], statuses: {} }

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x80, 0xc3])

function bridged(host: Pick<PluginApi, "server" | "workspaces">) {
  const channel = new MessageChannel()
  const hostPort = createHostPort({ port: channel.port1, api: host as PluginApi, mirror: () => MIRROR })
  const link = createFrameLink(channel.port2, MIRROR)
  const entries = { pages: new Map(), settings: new Map(), overlays: new Map(), commands: new Map(), mentions: new Map() }
  const frame = createFrameApi({ link, context: { pluginId: "fixture", pluginVersion: "0.1.0", platform: "web" }, entries, dictionary: undefined, forward: false, signal: new AbortController().signal })
  return { frame, dispose: hostPort.dispose }
}

const answering = (response: () => Response): Pick<PluginApi, "server" | "workspaces"> => ({
  server: { fetch: async () => response(), operation: async () => undefined },
  workspaces: { followStart: async () => ({ kind: "running" }) },
})

describe("the web frame's server.fetch", () => {
  test("a binary response reaches the frame byte for byte, and a UTF-8 text response as the same text", async () => {
    const binary = bridged(answering(() => new Response(PNG_BYTES, { headers: { "content-type": "image/png" } })))
    const image = await binary.frame.server.fetch("/api/claxedo/tasks/tasks/tsk_1/attachments/att_1")
    expect(image.headers.get("content-type")).toBe("image/png")
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG_BYTES)
    binary.dispose()

    const text = bridged(answering(() => Response.json({ name: "Café ☕" })))
    expect(await (await text.frame.server.fetch("/api/claxedo/tasks/presets")).json()).toEqual({ name: "Café ☕" })
    text.dispose()

    const empty = bridged(answering(() => new Response(null, { status: 204 })))
    expect((await empty.frame.server.fetch("/api/claxedo/tasks/presets")).status).toBe(204)
    empty.dispose()
  })
})

describe("the web frame's workspace calls", () => {
  test("followStart hands the frame each progress line before its answer", async () => {
    const { frame, dispose } = bridged({
      server: { fetch: async () => new Response(null), operation: async () => undefined },
      workspaces: {
        followStart: async (_workspaceId, onProgress) => {
          onProgress("Starting the machine")
          onProgress(undefined)
          return { kind: "failed", message: "The image has no runtime" }
        },
      },
    })
    const lines: (string | undefined)[] = []
    expect(await frame.workspaces.followStart("ws_cloud", (text) => lines.push(text))).toEqual({ kind: "failed", message: "The image has no runtime" })
    expect(lines).toEqual(["Starting the machine", undefined])
    dispose()
  })
})

describe("the web frame's response bodies", () => {
  test("only a type whose UTF-8 decoding keeps its bytes crosses as text", () => {
    expect(frameBodyEncoding("application/json")).toBe("utf8")
    expect(frameBodyEncoding("text/html; charset=UTF-8")).toBe("utf8")
    expect(frameBodyEncoding("application/problem+json")).toBe("utf8")
    expect(frameBodyEncoding("text/plain; charset=iso-8859-1")).toBe("base64")
    expect(frameBodyEncoding("image/png")).toBe("base64")
    expect(frameBodyEncoding("application/octet-stream")).toBe("base64")
    expect(frameBodyEncoding(null)).toBe("base64")
  })
})
