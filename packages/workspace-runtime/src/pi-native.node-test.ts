// `node:test`'s `describe`/`test` return a promise the runner already owns: it
// settles when the suite finishes and reports failures through the runner
// rather than rejecting, so every registration below is deliberately `void`ed.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createServer, type ServerResponse } from "node:http"
import { asRecordOrEmpty } from "@claxedo/helpers/guards"
import { PI_BROKER_PLACEHOLDER, PI_DIRECT_SECRET, PI_NATIVE_MODEL, piNativeRuntime, piNativeSnapshot, type PiNativeRoots } from "./test-support/pi-native-runtime"

type Reply = { tool?: { name: string; arguments: object }; text?: string; hold?: true }

function write(response: ServerResponse, sequence: number, reply: Reply) {
  const delta = reply.tool
    ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${sequence}`, type: "function", function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.arguments) } }] }
    : { role: "assistant", content: reply.text ?? "ok" }
  response.writeHead(200, { "content-type": "text/event-stream" })
  for (const chunk of [{ choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: reply.tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }]) {
    response.write(`data: ${JSON.stringify({ id: `proof-${sequence}`, object: "chat.completion.chunk", created: 1, model: "proof", ...chunk })}\n\n`)
  }
  response.end("data: [DONE]\n\n")
}

async function provider(replies: Reply[]) {
  const requests: { body: any; authorization?: string }[] = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push({ body: JSON.parse(Buffer.concat(chunks).toString()), authorization: request.headers.authorization })
    const reply = replies.shift() ?? { text: "ok" }
    if (!reply.hold) write(response, requests.length, reply)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing provider address")
  return { requests, replies, url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }) }
}

async function roots(name: string, providerUrl: string): Promise<PiNativeRoots & { root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), name))
  await fs.mkdir(path.join(root, "repo"))
  return { root, directory: path.join(root, "repo"), storeRoot: path.join(root, "runtime"), harnessStateRoot: path.join(root, "harness"), providerUrl }
}

function caller(runtime: ReturnType<typeof piNativeRuntime>) {
  return async (resource: string, body: object) => {
    const response = await runtime.app.request(`http://localhost/${resource.startsWith("checkpoint/") ? "api/wr/" : ""}${resource}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    const text = await response.text()
    assert.equal(response.status, resource.startsWith("session?") ? 201 : 200, `${resource}: ${text}`)
    return text ? JSON.parse(text) : undefined
  }
}

const sessionFiles = async (harnessStateRoot: string) => (await fs.readdir(harnessStateRoot, { recursive: true })).filter((file) => file.endsWith(".sqlite"))

void test("native Pi HTTP routes keep the session across checkpoint scrub and restart, spending only the direct secret", { timeout: 60_000 }, async () => {
  const model = await provider([{ tool: { name: "write", arguments: { path: "proof.txt", content: "native machine tool" } } }, { text: "Machine turn complete" }])
  const paths = await roots("pi-machine-http-", model.url)
  let runtime = piNativeRuntime(paths)
  try {
    await runtime.host.apply(piNativeSnapshot(model.url))
    let call = caller(runtime)
    const session = await call("session?nativeHarness=pi", { title: "Native machine proof", model: PI_NATIVE_MODEL })
    const sibling = await call("session?nativeHarness=pi", { title: "A second Pi session in the same store", model: PI_NATIVE_MODEL })
    assert.notEqual(sibling.id, session.id)
    await call(`session/${session.id}/message`, { messageID: "first", model: PI_NATIVE_MODEL, parts: [{ type: "text", text: "Write proof.txt" }] })
    assert.equal(await fs.readFile(path.join(paths.directory, "proof.txt"), "utf8"), "native machine tool")
    const files = await sessionFiles(paths.harnessStateRoot)
    assert.equal(files.length, 2)
    await call("checkpoint/freeze", { policy: "drain" })
    await call("checkpoint/flush", {})
    await call("checkpoint/scrub", {})
    assert.deepEqual(await sessionFiles(paths.harnessStateRoot), files)
    await runtime.dispose()
    runtime = piNativeRuntime(paths)
    await runtime.host.apply(piNativeSnapshot(model.url))
    call = caller(runtime)
    await call(`session/${session.id}/message`, { messageID: "second", model: PI_NATIVE_MODEL, parts: [{ type: "text", text: "Continue" }] })
    assert.equal(model.requests.at(-1)!.body.messages.filter((message: any) => message.role === "user").length, 2)
    assert.deepEqual([...new Set(model.requests.map((request) => request.authorization))], [`Bearer ${PI_DIRECT_SECRET}`])
    assert.ok(!model.requests.some((request) => JSON.stringify(request).includes(PI_BROKER_PLACEHOLDER)))
    const history = await runtime.app.request(`http://localhost/session/${session.id}/message`)
    assert.ok((await history.text()).includes("Machine turn complete"))
  } finally {
    await runtime.dispose()
    await model.close()
    await fs.rm(paths.root, { recursive: true, force: true })
  }
})

void test("a daemon killed mid-turn resumes Pi's run on restart as a continuation turn, once the first snapshot brings its credentials", { timeout: 60_000 }, async () => {
  const model = await provider([{ hold: true }, { text: "Answered after the restart" }])
  const paths = await roots("pi-machine-crash-", model.url)
  const child = spawn(process.execPath, [...process.execArgv, path.join(import.meta.dirname, "test-support/pi-native-runtime.ts"), "crash-child", JSON.stringify(paths)],
    { stdio: ["ignore", "pipe", "inherit"] })
  const requested = (async () => { while (model.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 20)) })()
  await requested
  child.kill("SIGKILL")
  await new Promise((resolve) => child.once("exit", resolve))
  const runtime = piNativeRuntime(paths)
  try {
    const history = async () => (await runtime.app.request("http://localhost/session/crash-proof/message")).text()
    const status = async () => {
      const statuses: unknown = await (await runtime.app.request("http://localhost/session/status")).json()
      return asRecordOrEmpty(asRecordOrEmpty(statuses)["crash-proof"]).type
    }
    await history()
    assert.equal(await status(), "interrupted")
    assert.equal(model.requests.length, 1)
    await runtime.host.apply(piNativeSnapshot(model.url))
    const deadline = Date.now() + 30_000
    while (!(await history()).includes("Answered after the restart") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok((await history()).includes("Answered after the restart"))
    assert.equal(model.requests.length, 2)
    assert.deepEqual([...new Set(model.requests.map((request) => request.authorization))], [`Bearer ${PI_DIRECT_SECRET}`])
  } finally {
    await runtime.dispose()
    await model.close()
    await fs.rm(paths.root, { recursive: true, force: true })
  }
})

void test("a background job a Pi command starts survives the command and ends with the runtime", { timeout: 60_000 }, async () => {
  const model = await provider([])
  const paths = await roots("pi-machine-background-", model.url)
  const pidFile = path.join(paths.directory, "background.pid")
  // The job records its own pid: `$!` under Git Bash is an MSYS pid the kernel does not know.
  const job = `'${process.execPath}' -e 'require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 30_000)'`
  model.replies.push({ tool: { name: "bash", arguments: { command: `${job} & echo started` } } }, { text: "Background started" })
  const runtime = piNativeRuntime(paths)
  try {
    await runtime.host.apply(piNativeSnapshot(model.url))
    const call = caller(runtime)
    const session = await call("session?nativeHarness=pi", { title: "Background proof", model: PI_NATIVE_MODEL })
    await call(`session/${session.id}/message`, { messageID: "first", model: PI_NATIVE_MODEL, parts: [{ type: "text", text: "Start it" }] })
    const started = Date.now() + 10_000
    while (!existsSync(pidFile) && Date.now() < started) await new Promise((resolve) => setTimeout(resolve, 50))
    const pid = Number(await fs.readFile(pidFile, "utf8"))
    assert.doesNotThrow(() => process.kill(pid, 0))
    await runtime.dispose()
    const deadline = Date.now() + 10_000
    const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
    while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(alive(), false)
  } finally {
    await runtime.dispose()
    await model.close()
    await fs.rm(paths.root, { recursive: true, force: true })
  }
})
