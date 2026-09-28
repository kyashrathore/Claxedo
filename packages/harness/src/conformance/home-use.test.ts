import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import type { HarnessTransport, SessionBroker, StartInput } from "../contract"
import { CodexAppServerTransport } from "../transports/codex-app-server"
import { CursorSdkTransport } from "../transports/cursor-sdk"
import { createTestServices } from "./test-support/services"

for (const kind of ["codex", "cursor"] as const) {
  for (const refuse of [false, true]) {
    test(`${kind} records home use before composing and hands the home to its ${refuse ? "refused " : ""}launch`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "home-conformance-"))
      const services = createTestServices()
      const order: string[] = []
      let home: string | undefined
      services.recordHomeUse = async (directory) => {
        home = directory
        expect(await fs.exists(directory)).toBe(false)
        order.push("use")
      }
      services.spawn = async (_command, options) => {
        expect(order).toEqual(["use"])
        expect(options.home).toBe(home)
        expect(await fs.exists(home!)).toBe(true)
        order.push("spawn")
        if (refuse) throw new Error("scripted launch refusal")
        const stdin = new PassThrough()
        const stdout = new PassThrough()
        const exit = Promise.withResolvers<{ code: number; signal: null }>()
        stdin.on("data", (chunk: Buffer) => {
          for (const line of chunk.toString().trim().split("\n")) {
            const frame = JSON.parse(line) as { id?: number; method?: string; kind?: string }
            if (frame.id === undefined) continue
            const reply = kind === "cursor" ? { id: frame.id, kind: "result", value: { agentId: "agent" } }
              : { id: frame.id, result: frame.method === "thread/start" ? { thread: { id: "agent" } } : {} }
            stdout.write(`${JSON.stringify(reply)}\n`)
          }
        })
        return { pid: 5_000_010, stdin, stdout, stderr: new PassThrough(), exited: exit.promise,
          retire: async () => { order.push("retire"); exit.resolve({ code: 0, signal: null }); return { stopped: true } } }
      }
      const transport: HarnessTransport = kind === "codex"
        ? new CodexAppServerTransport(services, { binary: "scripted", homeRoot: path.join(root, "homes"), ownerHome: path.join(root, "owner") })
        : new CursorSdkTransport(services, { homeRoot: path.join(root, "homes"), worker: { file: process.execPath, args: ["cursor-worker.js"] }, env: { HOME: root, CURSOR_API_KEY: "fixture" },
          placement: "loopback", machineOwnerUserId: "owner", canUseOwnLogin: true })
      const input: StartInput = { sessionId: "session", workspaceId: "workspace", directory: root, locality: "local", owner: { kind: "machine-owner" },
        config: { harness: { id: kind, access: "native" } },
        projection: { generation: "one", mcpServers: [], pluginRoots: [], notApplied: [] }, credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "one" } }
      const broker = { rebind: async (upstreamSessionId: string) => ({ sessionId: "session", workspaceId: "workspace", directory: root,
        connectionId: kind, upstreamSessionId }) } as SessionBroker
      try {
        if (refuse) await expect(transport.start(input, broker)).rejects.toThrow("scripted launch refusal")
        else {
          const session = await transport.start(input, broker)
          expect(order).toEqual(["use", "spawn"])
          await transport.close(session)
        }
        expect(order).toEqual(refuse ? ["use", "spawn"] : ["use", "spawn", "retire"])
      } finally { await transport.dispose(); await fs.rm(root, { recursive: true, force: true }) }
    })
  }
}
