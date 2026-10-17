import { expect, test } from "bun:test"
import { ServerError, type McpAppTool } from "@/server"
import type { ConfirmOptions } from "@/ui"
import type { AppServerCalls } from "./api"
import type { AppReader, ConsentText } from "./consent"
import { createAppRequests, appMessageText } from "./requests"

const owner: AppReader = { owner: true, send: true }
const sender: AppReader = { owner: false, send: true }
const follower: AppReader = { owner: false, send: false }

const text: ConsentText = (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key)

function fixture(input: { reader?: AppReader; tools?: McpAppTool[]; confirm?: boolean; fail?: unknown; send?: boolean; sendFails?: boolean } = {}) {
  const log: string[] = []
  const prompts: ConfirmOptions[] = []
  const states: string[] = []
  const calls: AppServerCalls = {
    tools: async () => {
      log.push("tools")
      if (input.fail) throw input.fail
      return input.tools ?? []
    },
    callTool: async (tool, args) => {
      log.push(`call:${tool}:${JSON.stringify(args)}`)
      return { content: [{ type: "text", text: "done" }] }
    },
    readResource: async (uri) => {
      log.push(`read:${uri}`)
      if (input.fail) throw input.fail
      return { contents: [] }
    },
  }
  const requests = createAppRequests({
    server: "weather",
    reader: () => input.reader ?? owner,
    calls,
    sendPrompt: input.send === false ? undefined : async (message) => {
      log.push(`send:${message}`)
      return input.sendFails ? { ok: false, message: "The session is busy" } : { ok: true }
    },
    confirm: async (options) => {
      prompts.push(options)
      return input.confirm ?? true
    },
    text,
    operationUnavailable: () => states.push("unavailable"),
    operationAnswered: () => states.push("answered"),
  })
  return { requests, log, prompts, states }
}

const tool = (name: string, overrides: Partial<McpAppTool> = {}): McpAppTool => ({ name, readOnly: false, visibleToApp: true, ...overrides })

test("tools/call: asks before a tool that is not read-only, naming the server, tool and arguments, then runs it", async () => {
  const f = fixture({ tools: [tool("book")] })
  const answer = await f.requests.callTool({ name: "book", arguments: { seat: "12A" } })
  expect(answer).toEqual({ kind: "result", result: { content: [{ type: "text", text: "done" }] } })
  expect(f.prompts).toHaveLength(1)
  expect(f.prompts[0]?.body).toContain('"server":"weather"')
  expect(f.prompts[0]?.body).toContain('"tool":"book"')
  expect(f.prompts[0]?.body).toContain("12A")
  expect(f.log).toEqual(["tools", 'call:book:{"seat":"12A"}'])
})

test("tools/call: a declined call never reaches the server", async () => {
  const f = fixture({ tools: [tool("book")], confirm: false })
  const answer = await f.requests.callTool({ name: "book", arguments: {} })
  expect(answer).toMatchObject({ kind: "error", error: { message: "The reader declined the tool call" } })
  expect(f.log).toEqual(["tools"])
})

test("tools/call: a read-only tool runs without a prompt", async () => {
  const f = fixture({ tools: [tool("forecast", { readOnly: true })] })
  expect(await f.requests.callTool({ name: "forecast" })).toMatchObject({ kind: "result" })
  expect(f.prompts).toEqual([])
  expect(f.log).toEqual(["tools", "call:forecast:{}"])
})

test("tools/call: follow and send readers are refused without a prompt or a server call", async () => {
  for (const reader of [follower, sender]) {
    const f = fixture({ reader, tools: [tool("forecast", { readOnly: true })] })
    expect(await f.requests.callTool({ name: "forecast" })).toMatchObject({ kind: "error", error: { message: "Only the session's owner can run tools from an app" } })
    expect(await f.requests.readResource({ uri: "ui://weather/app" })).toMatchObject({ kind: "error" })
    expect(f.prompts).toEqual([])
    expect(f.log).toEqual([])
  }
})

test("tools/call: refuses a tool the server does not list or hides from apps", async () => {
  const f = fixture({ tools: [tool("secret", { visibleToApp: false, readOnly: true })] })
  expect(await f.requests.callTool({ name: "missing" })).toMatchObject({ error: { message: "The server has no tool named missing" } })
  expect(await f.requests.callTool({ name: "secret" })).toMatchObject({ error: { message: "The tool secret is not offered to apps" } })
  expect(f.log).toEqual(["tools", "tools"])
})

test("tools/call: an unsupported operation or a sleeping runtime marks the app unavailable", async () => {
  const unsupported = new ServerError({ class: "conflict", message: "no", status: 409, code: "unsupported_operation" })
  const asleep = new ServerError({ class: "runtime_unreachable", message: "asleep", code: "runtime_asleep" })
  for (const fail of [unsupported, asleep]) {
    const f = fixture({ fail })
    expect(await f.requests.callTool({ name: "x" })).toMatchObject({ kind: "error", error: { message: "The app's server is unavailable; send a message in the session first" } })
    expect(f.states).toEqual(["unavailable"])
  }
  const missing = fixture({ fail: new ServerError({ class: "not_found", message: "No such server", status: 404 }) })
  expect(await missing.requests.readResource({ uri: "ui://x" })).toMatchObject({ kind: "error", error: { message: "No such server" } })
  expect(missing.states).toEqual([])
})

test("tools/call: validates its parameters", async () => {
  const f = fixture()
  expect(await f.requests.callTool({ arguments: {} })).toMatchObject({ error: { code: -32602 } })
  expect(await f.requests.callTool({ name: "x", arguments: "nope" })).toMatchObject({ error: { code: -32602 } })
  expect(await f.requests.readResource({})).toMatchObject({ error: { code: -32602 } })
  expect(f.log).toEqual([])
})

const params = { role: "user", content: [{ type: "text", text: "Book the 9:40" }] }

test("ui/message: always asks, then sends as the reader", async () => {
  const f = fixture({ reader: sender })
  expect(await f.requests.message(params)).toEqual({ kind: "result", result: {} })
  expect(f.prompts).toHaveLength(1)
  expect(f.log).toEqual(["send:Book the 9:40"])
})

test("ui/message: a declined message is never sent", async () => {
  const f = fixture({ confirm: false })
  expect(await f.requests.message(params)).toMatchObject({ kind: "error", error: { message: "The reader declined the message" } })
  expect(f.log).toEqual([])
})

test("ui/message: a follow reader, or a reader with no send, is refused without a prompt", async () => {
  for (const f of [fixture({ reader: follower }), fixture({ send: false })]) {
    expect(await f.requests.message(params)).toMatchObject({ kind: "error", error: { message: "This reader cannot send messages to the session" } })
    expect(f.prompts).toEqual([])
    expect(f.log).toEqual([])
  }
})

test("ui/message: a failed send answers the app with the send owner's message", async () => {
  const f = fixture({ sendFails: true })
  expect(await f.requests.message(params)).toMatchObject({ kind: "error", error: { message: "The session is busy" } })
  expect(f.log).toEqual(["send:Book the 9:40"])
})

test("ui/message: takes text content only", () => {
  expect(appMessageText(params)).toBe("Book the 9:40")
  expect(appMessageText({ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("a\n\nb")
  expect(appMessageText({ role: "user", content: [{ type: "image", data: "x" }] })).toBeUndefined()
  expect(appMessageText({ role: "assistant", content: [{ type: "text", text: "a" }] })).toBeUndefined()
  expect(appMessageText({ role: "user", content: [{ type: "text", text: "  " }] })).toBeUndefined()
})
