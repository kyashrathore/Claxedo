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
import { loopbackMachineLoginPolicy } from "./testing"

void test(
  "native Pi machine HTTP routes keep the session across checkpoint scrub and restart, sending only the placeholder",
  { timeout: 60_000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-machine-http-"))
    const directory = path.join(root, "repo")
    const storeRoot = path.join(root, "runtime")
    const harnessStateRoot = path.join(root, "harness")
    await fs.mkdir(directory)
    const requests: any[] = []
    const authorizations: Array<string | undefined> = []
    const provider = createServer(async (request, response) => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      requests.push(JSON.parse(Buffer.concat(chunks).toString()))
      authorizations.push(request.headers.authorization)
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
    const placeholder = "proof-placeholder"
    const model = { providerID: "pi", modelID: "groq/llama-3.1-8b-instant" }
    const create = () =>
      createWorkspaceRuntimeApp({
        placement: loopbackMachineLoginPolicy(),
        target: { workspaceId: "workspace-proof", directory },
        sessionIdWorkspace: () => undefined,
        storeRoot,
        harnessStateRoot,
        harness: { kind: "native", harnessId: "pi" },
        exposure: loopbackWorkspaceRuntimeExposure(),
      })
    let runtime = create()
    const snapshot = {
      version: 4 as const,
      defaultHarness: { kind: "native" as const, harnessId: "pi" as const },
      mcp: {},
      connections: [],
      auth: {
        machineOwnerUserId: "local",
        accounts: {
          local: {
            groq: {
              baseUrl: `http://127.0.0.1:${address.port}/bindings/proof`,
              placeholder,
              authMode: "bearer" as const,
              apiPath: "/openai/v1",
            },
          },
        },
      },
      commands: [],
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
        model,
      })
      assert.ok(session.id)
      await call(`session/${session.id}/message`, {
        messageID: "first",
        model,
        parts: [{ type: "text", text: "Write proof.txt" }],
      })
      assert.equal(await fs.readFile(path.join(directory, "proof.txt"), "utf8"), "native machine tool")
      const nativeFiles = async () => (await fs.readdir(harnessStateRoot, { recursive: true })).filter((file) => file.endsWith(".jsonl"))
      const files = await nativeFiles()
      assert.equal(files.length, 1)
      await call("checkpoint/freeze", { policy: "drain" })
      await call("checkpoint/flush", {})
      await call("checkpoint/scrub", {})
      assert.deepEqual(await nativeFiles(), files)
      await runtime.dispose()
      runtime = create()
      await runtime.host.apply(snapshot)
      await call(`session/${session.id}/message`, {
        messageID: "second",
        model,
        parts: [{ type: "text", text: "Continue" }],
      })
      assert.equal(requests.at(-1).messages.filter((message: any) => message.role === "user").length, 2)
      assert.deepEqual([...new Set(authorizations)], [`Bearer ${placeholder}`])
      assert.deepEqual(await nativeFiles(), files)
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
