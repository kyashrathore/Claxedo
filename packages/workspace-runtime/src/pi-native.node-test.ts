// `node:test`'s `describe`/`test` return a promise the runner already owns: it
// settles when the suite finishes and reports failures through the runner
// rather than rejecting, so every registration below is deliberately `void`ed.
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createServer } from "node:http"
import { createWorkspaceRuntimeApp } from "./server"
import { loopbackWorkspaceRuntimeExposure } from "./exposure"

void test(
  "lazy Pi admission clears crash-left credentials before its first unauthenticated HTTP turn",
  { skip: !process.env.PI_EXECUTABLE, timeout: 60_000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-cold-auth-"))
    const directory = path.join(root, "repo")
    const storeRoot = path.join(root, "runtime")
    const agentDir = path.join(storeRoot, "pi", "agent")
    await fs.mkdir(directory)
    await fs.mkdir(agentDir, { recursive: true })
    let requests = 0
    const provider = createServer((_request, response) => {
      requests++
      response.writeHead(401, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { message: "Unexpected stale credential request" } }))
    })
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve))
    const address = provider.address()
    if (!address || typeof address === "string") throw new Error("Missing provider address")
    await fs.writeFile(
      path.join(agentDir, "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: "crash-left-secret" } }),
    )
    await fs.writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: { openai: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions" } },
      }),
    )
    const runtime = createWorkspaceRuntimeApp({
      target: { workspaceId: "cold-auth", directory },
      storeRoot,
      exposure: loopbackWorkspaceRuntimeExposure(),
    })
    const post = (resource: string, body: object) =>
      runtime.app.request(`http://localhost/${resource}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    try {
      await runtime.host.apply({ version: 4, mcp: {}, connections: [], auth: {} })
      const model = { providerID: "pi", modelID: "openai/gpt-4.1" }
      const created = await post("session?nativeHarness=pi", { model })
      assert.equal(created.status, 201, await created.clone().text())
      const session = await created.json()
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(agentDir, "auth.json"), "utf8")), {})
      const response = await post(`session/${session.id}/message`, {
        messageID: "no-credential",
        model,
        parts: [{ type: "text", text: "Hello" }],
      })
      const result = await response.text()
      assert.match(result, /api key|credential/i)
      assert.equal(requests, 0, "Pi must reject locally before sending any stale credential")
    } finally {
      await runtime.dispose()
      provider.closeAllConnections()
      await new Promise<void>((resolve) => provider.close(() => resolve()))
      await fs.rm(root, { recursive: true, force: true })
    }
  },
)

void test(
  "native Pi machine HTTP routes retain sessions and scrub auth across checkpoint/restart",
  { skip: !process.env.PI_EXECUTABLE, timeout: 60_000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-machine-http-"))
    const directory = path.join(root, "repo")
    const storeRoot = path.join(root, "runtime")
    const agentDir = path.join(storeRoot, "pi", "agent")
    await fs.mkdir(directory)
    await fs.mkdir(agentDir, { recursive: true })
    const requests: any[] = []
    const provider = createServer(async (request, response) => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      requests.push(JSON.parse(Buffer.concat(chunks).toString()))
      const tool = requests.length === 1
      const delta = tool
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "write-proof",
                type: "function",
                function: {
                  name: "write",
                  arguments: JSON.stringify({ path: "proof.txt", content: "native machine tool" }),
                },
              },
            ],
          }
        : { role: "assistant", content: "Machine turn complete" }
      response.writeHead(200, { "content-type": "text/event-stream" })
      for (const chunk of [
        { choices: [{ index: 0, delta, finish_reason: null }] },
        {
          choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        },
      ])
        response.write(
          `data: ${JSON.stringify({ id: `proof-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "proof", ...chunk })}\n\n`,
        )
      response.end("data: [DONE]\n\n")
    })
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve))
    const address = provider.address()
    if (!address || typeof address === "string") throw new Error("Missing provider address")
    await fs.writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          proof: {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            api: "openai-completions",
            apiKey: "test-provider",
            models: [{ id: "proof", reasoning: false, contextWindow: 32000, maxTokens: 4096 }],
          },
        },
      }),
    )
    const create = () =>
      createWorkspaceRuntimeApp({
        target: { workspaceId: "workspace-proof", directory },
        storeRoot,
        harness: { kind: "native", harnessId: "pi" },
        exposure: loopbackWorkspaceRuntimeExposure(),
      })
    let runtime = create()
    const snapshot = {
      version: 4 as const,
      defaultHarness: { kind: "native" as const, harnessId: "pi" as const },
      mcp: {},
      connections: [],
      auth: {},
    }
    const call = async (resource: string, body: object) => {
      const response = await runtime.app.request(
        `http://localhost/${resource.startsWith("checkpoint/") ? "api/wr/" : ""}${resource}`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      )
      const text = await response.text()
      assert.equal(response.status, resource.startsWith("session?") ? 201 : 200, `${resource}: ${text}`)
      return text ? JSON.parse(text) : undefined
    }
    try {
      await runtime.host.apply(snapshot)
      const session = await call("session?nativeHarness=pi", {
        title: "Native machine proof",
        model: { providerID: "pi", modelID: "proof/proof" },
      })
      assert.ok(session.id)
      await call(`session/${session.id}/message`, {
        messageID: "first",
        model: { providerID: "pi", modelID: "proof/proof" },
        parts: [{ type: "text", text: "Write proof.txt" }],
      })
      assert.equal(await fs.readFile(path.join(directory, "proof.txt"), "utf8"), "native machine tool")
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(agentDir, "auth.json"), "utf8")), {})
      const nativeFiles = await fs.readdir(path.join(agentDir, "sessions"))
      assert.equal(nativeFiles.filter((file) => file.endsWith(".jsonl")).length, 1)
      await call("checkpoint/freeze", { policy: "drain" })
      await call("checkpoint/flush", {})
      await call("checkpoint/scrub", {})
      await assert.rejects(fs.access(path.join(agentDir, "auth.json")))
      assert.deepEqual(await fs.readdir(path.join(agentDir, "sessions")), nativeFiles)
      await runtime.dispose()
      runtime = create()
      await runtime.host.apply(snapshot)
      await call(`session/${session.id}/message`, {
        messageID: "second",
        model: { providerID: "pi", modelID: "proof/proof" },
        parts: [{ type: "text", text: "Continue" }],
      })
      assert.equal(requests.at(-1).messages.filter((message: any) => message.role === "user").length, 2)
      assert.deepEqual(await fs.readdir(path.join(agentDir, "sessions")), nativeFiles)
      const history = await runtime.app.request(`http://localhost/session/${session.id}/message`)
      assert.equal(history.status, 200)
      assert.ok((await history.text()).includes("Machine turn complete"))
    } finally {
      await runtime.dispose()
      provider.closeAllConnections()
      await new Promise<void>((resolve) => provider.close(() => resolve()))
      await fs.rm(root, { recursive: true, force: true })
    }
  },
)
