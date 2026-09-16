import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { PiRpcMessage } from "./rpc-process"
import { PI_TITLE_COMMAND, PI_TITLE_EXTENSION_SOURCE, ensurePiTitleExtension, generatePiTitle, setPiSessionName, type PiTitleProcess } from "./title-extension"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

function fakeProcess(onPrompt?: (emit: (event: PiRpcMessage) => void) => void) {
  const calls: Array<{ type: string; body: Record<string, unknown> }> = []
  const listeners = new Set<(event: PiRpcMessage) => void>()
  const emit = (event: PiRpcMessage) => { for (const listener of listeners) listener(event) }
  const proc: PiTitleProcess = {
    async request(type, body = {}) {
      calls.push({ type, body })
      if (type === "prompt") onPrompt?.(emit)
      return {}
    },
    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return { proc, calls, listeners }
}

const request = { directory: "/work", system: "Name it", user: "User: add leap-year tests", signal: new AbortController().signal }

describe("Pi title extension", () => {
  test("is written into the profile once and rewritten only when its source changes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-title-"))
    roots.push(root)
    const file = await ensurePiTitleExtension(root)
    expect(await fs.readFile(file, "utf8")).toBe(PI_TITLE_EXTENSION_SOURCE)
    const first = (await fs.stat(file)).mtimeMs
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(await ensurePiTitleExtension(root)).toBe(file)
    expect((await fs.stat(file)).mtimeMs).toBe(first)
    await fs.writeFile(file, "stale")
    await ensurePiTitleExtension(root)
    expect(await fs.readFile(file, "utf8")).toBe(PI_TITLE_EXTENSION_SOURCE)
  })

  test("the extension registers the command and names the session from the reply", () => {
    expect(PI_TITLE_EXTENSION_SOURCE).toContain(`pi.registerCommand("${PI_TITLE_COMMAND}"`)
    expect(PI_TITLE_EXTENSION_SOURCE).toContain("ctx.modelRegistry.complete(model")
    expect(PI_TITLE_EXTENSION_SOURCE).toContain("pi.setSessionName(title)")
    expect(PI_TITLE_EXTENSION_SOURCE).toContain('reply.stopReason === "error"')
  })

  test("generatePiTitle invokes the command with the request and returns the announced name", async () => {
    const { proc, calls, listeners } = fakeProcess((emit) => emit({ type: "session_info_changed", name: "Add leap-year tests" }))
    await expect(generatePiTitle(proc, request)).resolves.toBe("Add leap-year tests")
    expect(calls).toEqual([{ type: "prompt", body: { message: `/${PI_TITLE_COMMAND} ${JSON.stringify({ system: "Name it", user: "User: add leap-year tests" })}` } }])
    expect(listeners.size).toBe(0)
  })

  test("generatePiTitle surfaces the command's error so the runtime can log the cause", async () => {
    const { proc } = fakeProcess((emit) => emit({ type: "extension_error", extensionPath: `command:${PI_TITLE_COMMAND}`, event: "command", error: "OAuth refresh failed for anthropic" }))
    await expect(generatePiTitle(proc, request)).rejects.toThrow("OAuth refresh failed for anthropic")
  })

  test("generatePiTitle yields null when the command set no name", async () => {
    const { proc } = fakeProcess()
    await expect(generatePiTitle(proc, request)).resolves.toBeNull()
  })

  test("setPiSessionName sends set_session_name and skips empty titles", async () => {
    const { proc, calls } = fakeProcess()
    await setPiSessionName(proc, "Add leap-year tests")
    await setPiSessionName(proc, " ")
    expect(calls).toEqual([{ type: "set_session_name", body: { name: "Add leap-year tests" } }])
  })
})
