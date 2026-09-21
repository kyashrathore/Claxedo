import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { AgentMessage } from "@claxedo/agent-runtime-contract"
import { toolImageResponse } from "./tool-image"
import { createSessionRoutes } from "./session-core"

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))) })
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tool-image-"))
  dirs.push(dir)
  const source = path.join(dir, "image.png")
  await fs.writeFile(source, png)
  const messages = [{ info: { id: "message", sessionID: "session", role: "assistant" }, parts: [{
    id: "tool", sessionID: "session", messageID: "message", type: "tool", state: {
      status: "completed", attachments: [{ id: "image", sessionID: "session", messageID: "message", type: "file", mime: "image/*", url: "", location: { kind: "tool-file", path: source } }],
    },
  }] }] as AgentMessage[]
  return { source, messages, input: { messages, sessionId: "session", messageId: "message", attachmentId: "image" } }
}

test("route reads do not start a harness, publish events or change messages, including failure and recovery", async () => {
  const { source, messages } = await fixture()
  const before = JSON.stringify(messages)
  let events = 0
  const app = createSessionRoutes({
    resolveAdapter: () => { throw new Error("Image reads must not start a harness") },
    resolveDirectory: () => "/workspace",
    getMessages: (_c, _dir, id) => id === "session" ? messages : undefined,
    publishGlobal: () => { events++ },
  })
  const read = () => app.request("http://localhost/session/session/message/message/attachment/image")
  const response = await read()
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toBe("image/png")
  expect(response.headers.get("cache-control")).toBe("private, no-store")
  expect(Buffer.from(await response.arrayBuffer())).toEqual(png)
  await fs.unlink(source)
  expect((await read()).status).toBe(404)
  await fs.writeFile(source, png)
  expect((await read()).status).toBe(200)
  expect(JSON.stringify(messages)).toBe(before)
  expect(events).toBe(0)
  expect((await app.request("http://localhost/session/other/message/message/attachment/image")).status).toBe(404)
})

test("requires matching session, message, attachment and an assistant completed result", async () => {
  const { input } = await fixture()
  for (const mismatch of [{ sessionId: "other" }, { messageId: "other" }, { attachmentId: "other" }]) {
    expect((await toolImageResponse({ ...input, ...mismatch })).status).toBe(404)
  }
  const message = input.messages[0]!
  message.info.role = "user"
  expect((await toolImageResponse(input)).status).toBe(404)
  message.info.role = "assistant"
  const part = message.parts[0]!
  if (part.type !== "tool") throw new Error("Expected tool")
  part.state.status = "running"
  expect((await toolImageResponse(input)).status).toBe(404)
})

test("rejects non-images, directories, symlinks and oversized files", async () => {
  const { input, source } = await fixture()
  await fs.writeFile(source, "private text")
  expect((await toolImageResponse(input)).status).toBe(415)
  await fs.truncate(source, 20 * 1024 * 1024 + 1)
  expect((await toolImageResponse(input)).status).toBe(413)
  await fs.unlink(source)
  await fs.mkdir(source)
  expect((await toolImageResponse(input)).status).toBe(404)
  await fs.rmdir(source)
  const target = `${source}.target`
  await fs.writeFile(target, png)
  await fs.symlink(target, source)
  expect((await toolImageResponse(input)).status).toBe(404)
})

test("authorizes image reads before looking up any stored message", async () => {
  let reads = 0
  const operations: string[] = []
  const app = createSessionRoutes({
    resolveAdapter: () => { throw new Error("Unexpected adapter") },
    resolveDirectory: () => "/workspace",
    getMessages: () => { reads++; return [] },
    publishGlobal() {},
    sessionAccessPolicy: {
      sessionAuthority: "managed-private",
      authorizeSessionStartStatus: () => ({ allowed: false as const, status: 403 as const, code: "startup_not_tested", message: "Startup is not admitted by this fixture" }),
      authorizeSessionStart: () => ({ allowed: false as const, status: 403 as const, code: "startup_not_tested", message: "Startup is not admitted by this fixture" }),
      authorize(input) {
        operations.push(`${input.operation}:${input.sessionId}`)
        return { allowed: false, status: 403, code: "session_private", message: "Forbidden" }
      },
      filterSessions: () => [],
      authorizePrefix: () => ({ allowed: false, status: 403, code: "session_private", message: "Forbidden" }),
    },
  })
  const response = await app.request("http://localhost/session/session/message/message/attachment/image?path=/tmp/other.png")
  expect(response.status).toBe(403)
  expect(operations).toEqual(["message_read:session"])
  expect(reads).toBe(0)
})
