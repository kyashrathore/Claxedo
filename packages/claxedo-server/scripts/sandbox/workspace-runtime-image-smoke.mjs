import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { createServer } from "node:net"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"

const directory = await mkdtemp(path.join(tmpdir(), "workspace-runtime-image-"))
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
  const created = await json("/session", mutation("POST", { id, title: "Image smoke" }))
  assert.equal(created.id, id)
  assert.equal(created.directory, directory)
  const config = await json(`/session/${id}/config`)
  assert.deepEqual(config.harness, { id: "pi", access: "native" })
  await json(`/session/${id}`, mutation("PATCH", { title: "Updated image smoke" }))
  const inventory = await json("/session")
  assert.equal(inventory.find((session) => session.id === id)?.title, "Updated image smoke")
  assert.deepEqual(await json(`/session/${id}/message`), [])
  const events = await fetch(`http://127.0.0.1:${port}/api/wr/runtime-events`, {
    signal: AbortSignal.timeout(20_000),
  })
  assert(events.ok && events.body, `runtime event stream did not open: ${events.status}${events.ok ? "" : ` ${await events.text()}`}`)
  const reader = events.body.getReader()
  const marker = "claxedo-image-native-turn"
  try {
    await json(`/session/${id}/message`, mutation("POST", {
      messageID: "msg_image_smoke", parts: [{ id: "prt_image_smoke", type: "text", text: `exec: printf ${marker}` }],
    }))
    const decoder = new TextDecoder()
    let received = ""
    while (!received.includes('"type":"finish"')) {
      const item = await reader.read()
      assert(!item.done, "runtime event stream ended before the turn finished")
      received += decoder.decode(item.value, { stream: true })
    }
    assert(received.includes(id), "runtime events omitted the canonical session identity")
    const history = await json(`/session/${id}/message?snapshot=1`)
    const assistant = history.messages.filter((message) => message.info.role === "assistant")
    assert.equal(assistant.flatMap((message) => message.parts).filter((part) => part.type === "text").map((part) => part.text).join(""), marker)
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
  await rm(directory, { recursive: true, force: true })
}
