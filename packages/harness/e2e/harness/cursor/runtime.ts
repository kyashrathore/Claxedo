import fs from "node:fs/promises"
import path from "node:path"
import { createWorkspaceRuntimeApp } from "../../../../workspace-runtime/src/server"
import { loopbackWorkspaceRuntimeExposure } from "../../../../workspace-runtime/src/exposure"
import { egressProxyEnv } from "../egress-guard"
import { reservePort, releasePort } from "../ports"
import { openEventStream, type EventStream } from "../stream"
import type { Stack } from "../stack"

export type CursorRuntime = {
  url: string
  directory: string
  applyBackend(index: number): Promise<void>
  events(): Promise<EventStream>
  close(): Promise<void>
}

export async function startCursorRuntime(stack: Stack): Promise<CursorRuntime> {
  if (!stack.cursor.length) throw new Error("The stack has no scripted Cursor backend")
  const directory = await fs.mkdtemp(path.join(stack.dataDir, "cursor-workspace-"))
  const port = await reservePort()
  const previous = Object.fromEntries([...Object.keys(egressProxyEnv(stack.egress.url)), "CURSOR_BACKEND_URL"].map((key) => [key, process.env[key]]))
  Object.assign(process.env, egressProxyEnv(stack.egress.url))
  const runtime = createWorkspaceRuntimeApp({
    target: { workspaceId: "ws_cursor_scripted", directory },
    storeRoot: directory,
    exposure: loopbackWorkspaceRuntimeExposure(),
    managementAuth: { authorize: async ({ request, action }) =>
      request.headers.get("x-workspace-runtime-management-token") === "scripted-cursor-management"
        ? { ok: true, subject: "cursor-e2e", scopes: [action] }
        : { ok: false, status: 401, code: "runtime_management_token_required", message: "management token required" } },
    managementTarget: { workspaceId: "ws_cursor_scripted", hostId: "host_cursor_scripted" },
  })
  const server = Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 255, fetch: runtime.app.fetch })
  const url = `http://127.0.0.1:${port}`
  const streams: EventStream[] = []
  return {
    url,
    directory,
    async applyBackend(index) {
      const backend = stack.cursor[index]
      if (!backend) throw new Error(`No Cursor backend at index ${index}`)
      const response = await fetch(`${url}/api/wr/config`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-workspace-runtime-management-token": "scripted-cursor-management" },
        body: JSON.stringify({
          version: 4,
          mcp: {},
          connections: [],
          defaultHarness: { kind: "native", harnessId: "cursor" },
          auth: { "cursor-sdk": {
            baseUrl: backend.url,
            placeholder: "cursor-placeholder",
            authMode: "bearer",
            expiresAt: Date.now() + 60 * 60 * 1000,
          } },
        }),
      })
      if (!response.ok) throw new Error(`Cursor runtime config push answered ${response.status}: ${await response.text()}`)
    },
    events: async () => {
      const stream = await openEventStream(url, directory)
      streams.push(stream)
      return stream
    },
    close: async () => {
      for (const stream of streams) stream.close()
      await runtime.dispose()
      await server.stop(true)
      releasePort(port)
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    },
  }
}
