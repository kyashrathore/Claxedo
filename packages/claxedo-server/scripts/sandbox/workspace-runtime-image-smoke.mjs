import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { createServer } from "node:net"
import { createServer as createHttpServer } from "node:http"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"

const directory = await mkdtemp(path.join(tmpdir(), "workspace-runtime-image-"))
const marker = "claxedo-image-native-turn"
const agentDir = path.join(directory, "pi-agent")
await mkdir(agentDir)
const providerRequests = []
const provider = createHttpServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  providerRequests.push(JSON.parse(Buffer.concat(chunks).toString()))
  const tool = providerRequests.length === 1
  const delta = tool ? {
    role: "assistant", tool_calls: [{ index: 0, id: "image-write", type: "function",
      function: { name: "write", arguments: JSON.stringify({ path: "native-proof.txt", content: marker }) } }],
  } : { role: "assistant", content: marker }
  response.writeHead(200, { "content-type": "text/event-stream" })
  for (const chunk of [
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } },
  ]) response.write(`data: ${JSON.stringify({ id: "image-proof", object: "chat.completion.chunk", created: 1, model: "proof", ...chunk })}\n\n`)
  response.end("data: [DONE]\n\n")
})
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve))
await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { proof: {
  baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: "openai-completions", apiKey: "image-proof-placeholder",
  models: [{ id: "proof", reasoning: false, contextWindow: 32000, maxTokens: 1024 }],
} } }))
const probe = createServer()
probe.listen(0, "127.0.0.1")
await once(probe, "listening")
const port = probe.address().port
await new Promise((resolve) => probe.close(resolve))
const runtime = spawn(process.argv[2] ? process.execPath : "workspace-runtime", process.argv[2] ? [path.resolve(process.argv[2])] : [], {
  cwd: directory,
  detached: true,
  stdio: "inherit",
  env: {
    ...process.env,
    WORKSPACE_RUNTIME_PORT: String(port),
    WORKSPACE_RUNTIME_HOST: "127.0.0.1",
    WORKSPACE_RUNTIME_WORKSPACE_ID: "image-smoke",
    WORKSPACE_RUNTIME_DIRECTORY: directory,
    WORKSPACE_RUNTIME_DATA_DIR: path.join(directory, "data"),
    WORKSPACE_RUNTIME_STATE_DIR: path.join(directory, "state"),
    WORKSPACE_RUNTIME_STORE_DIR: path.join(directory, "store"),
    WORKSPACE_RUNTIME_NATIVE_HARNESS: "pi",
    PI_CODING_AGENT_DIR: agentDir,
  },
})
let launchError
runtime.on("error", (error) => { launchError = error })

async function json(route, init) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, init)
  const body = await response.text()
  assert(response.ok, `${route}: ${response.status} ${body}`)
  return body ? JSON.parse(body) : undefined
}

try {
  let ready = false
  for (let attempt = 0; attempt < 120; attempt++) {
    if (launchError) throw launchError
    assert.equal(runtime.exitCode, null, "workspace-runtime exited before becoming ready")
    try {
      await json("/api/wr/health")
      ready = true
      break
    } catch {
      await delay(250)
    }
  }
  assert(ready, "workspace-runtime did not become ready")
  const id = `ses_image_${"w".repeat(200)}`
  const mutation = (method, body) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const created = await json("/session", mutation("POST", { id, title: "Image smoke", model: { providerID: "pi", modelID: "proof/proof" } }))
  assert.equal(created.id, id)
  assert.equal(created.directory, directory)
  const config = await json(`/session/${id}/config`)
  assert.deepEqual(config.harness, { id: "pi", access: "native" })
  await json(`/session/${id}`, mutation("PATCH", { title: "Updated image smoke" }))
  const inventory = await json("/session")
  assert.equal(inventory.find((session) => session.id === id)?.title, "Updated image smoke")
  assert.deepEqual(await json(`/session/${id}/message`), [])
  const events = await fetch(`http://127.0.0.1:${port}/api/wr/events`, {
    signal: AbortSignal.timeout(20_000),
  })
  assert(events.ok && events.body, `workspace event stream did not open: ${events.status}${events.ok ? "" : ` ${await events.text()}`}`)
  const reader = events.body.getReader()
  try {
    await json(`/session/${id}/message`, mutation("POST", {
      messageID: "msg_image_smoke", parts: [{ id: "prt_image_smoke", type: "text", text: "Write the requested proof file, then report completion" }],
    }))
    const decoder = new TextDecoder()
    let received = ""
    // The runtime projects the harness's `finish` to `session.idle` on its stream.
    while (!received.includes('"type":"session.idle"')) {
      const item = await reader.read()
      assert(!item.done, "workspace event stream ended before the turn finished")
      received += decoder.decode(item.value, { stream: true })
    }
    assert(received.includes(id), "runtime events omitted the canonical session identity")
    const history = await json(`/session/${id}/message?snapshot=1`)
    const assistant = history.messages.filter((message) => message.info.role === "assistant")
    assert.equal(assistant.flatMap((message) => message.parts).filter((part) => part.type === "text").map((part) => part.text).join(""), marker)
    assert.equal(await readFile(path.join(directory, "native-proof.txt"), "utf8"), marker)
    assert.equal(providerRequests.length, 2)
    assert(providerRequests[1].messages.some((message) => message.role === "tool"), "native tool result did not reach provider")
    assert(history.maxEventOrdinal > 0, "history omitted the committed event ordinal")
  } finally {
    await reader.cancel()
  }
  await json(`/session/${id}`, { method: "DELETE" })
  assert(!(await json("/session")).some((session) => session.id === id))
} finally {
  if (runtime.pid && runtime.exitCode === null) {
    const exited = once(runtime, "exit")
    process.kill(-runtime.pid, "SIGTERM")
    const stopped = await Promise.race([exited.then(() => true), delay(3000).then(() => false)])
    if (!stopped) {
      process.kill(-runtime.pid, "SIGKILL")
      await exited
    }
  }
  provider.closeAllConnections()
  await new Promise((resolve) => provider.close(resolve))
  await rm(directory, { recursive: true, force: true })
}
