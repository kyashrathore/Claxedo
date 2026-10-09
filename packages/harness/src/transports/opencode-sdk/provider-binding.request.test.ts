import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createServer } from "node:http"
import { CREDENTIAL_BROKER_ERRORS } from "@claxedo/agent-runtime-contract"
import { createOpenCodeRuntime, type OpenCodeRuntime } from "./runtime"
import { WorkspaceScope } from "./scope"
import { removeTempRoot } from "../../test-support/temp-root"

type Recorded = { path: string; authorization?: string; model: unknown }

function recordingEndpoint(refuse?: { status: number; body: string }) {
  const requests: Recorded[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { model?: unknown }
    requests.push({
      path: request.url ?? "",
      ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
      model: body.model,
    })
    if (refuse) {
      response.writeHead(refuse.status, { "content-type": "application/json" })
      response.end(refuse.body)
      return
    }
    response.writeHead(200, { "content-type": "text/event-stream" })
    for (const delta of [
      { choices: [{ index: 0, delta: { role: "assistant", content: "answered" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ]) response.write(`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "proof", ...delta })}\n\n`)
    response.end("data: [DONE]\n\n")
  })
  return {
    requests,
    async listen() {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
      const address = server.address()
      return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/v1`
    },
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

function engine(root: string, options?: Record<string, unknown>): { runtime: OpenCodeRuntime; scope: WorkspaceScope } {
  const directory = path.join(root, "work")
  fs.mkdirSync(directory, { recursive: true })
  return {
    runtime: createOpenCodeRuntime({
      databasePath: path.join(root, "opencode.db"),
      configContent: JSON.stringify({
        model: "proof/proof",
        small_model: "proof/proof",
        enabled_providers: ["proof"],
        provider: {
          proof: {
            npm: "@ai-sdk/openai-compatible",
            name: "Proof",
            models: { proof: { name: "Proof", limit: { context: 32_000, output: 1_024 } } },
            ...(options ? { options } : {}),
          },
        },
      }),
    }),
    scope: WorkspaceScope.authorize({ workspaceID: "w", directory }),
  }
}

async function turn(runtime: OpenCodeRuntime, scope: WorkspaceScope, until: () => boolean) {
  const session = await runtime.sessions.create(scope, { title: "routing" })
  runtime.instances.assign(session.id, runtime.instances.define(scope.directory, { skills: [], mcp: {} }))
  await runtime.sessions.switchModel(scope, session.id, { providerID: "proof", modelID: "proof" })
  await runtime.sessions.prompt(scope, session.id, { text: "say hello" })
  for (let wait = 0; wait < 300 && !until(); wait++) await new Promise((resolve) => setTimeout(resolve, 50))
  return session.id
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-binding-request-"))
  return { root, cleanup: () => removeTempRoot(root) }
}

test("a bound provider's request reaches the binding and carries its placeholder", async () => {
  const broker = recordingEndpoint()
  const brokerUrl = await broker.listen()
  const { root, cleanup } = fixture()
  const { runtime, scope } = engine(root)
  try {
    await runtime.bindProviders({ overlays: { proof: { baseURL: brokerUrl, apiKey: "broker-placeholder" } }, unbound: "engine" })

    await turn(runtime, scope, () => broker.requests.length > 0)

    expect(broker.requests).not.toHaveLength(0)
    expect(broker.requests[0]?.path).toBe("/v1/chat/completions")

    expect(broker.requests[0]?.authorization).toBe("Bearer broker-placeholder")
    expect(broker.requests[0]?.model).toBe("proof")
  } finally {
    await runtime.close()
    await broker.close()
    await cleanup()
  }
}, 60_000)

test("a withdrawn account sends nothing to the binding it used to name", async () => {
  const broker = recordingEndpoint()
  const brokerUrl = await broker.listen()
  const { root, cleanup } = fixture()
  const { runtime, scope } = engine(root)
  try {
    await runtime.bindProviders({ overlays: { proof: { baseURL: brokerUrl, apiKey: "broker-placeholder" } }, unbound: "engine" })
    await turn(runtime, scope, () => broker.requests.length > 0)
    expect(broker.requests).toHaveLength(1)

    await runtime.bindProviders({ overlays: { proof: { unavailable: true, reason: "auth_failed" } }, unbound: "engine" })
    await turn(runtime, scope, () => broker.requests.length > 1)

    expect(broker.requests).toHaveLength(1)
    expect(runtime.providerUnavailableReason("proof")).toBe("auth_failed")
  } finally {
    await runtime.close()
    await broker.close()
    await cleanup()
  }
}, 90_000)

test("a provider nobody bound sends nothing to the broker", async () => {
  const broker = recordingEndpoint()
  const brokerUrl = await broker.listen()
  const { root, cleanup } = fixture()
  const { runtime, scope } = engine(root)
  try {
    await runtime.bindProviders({ overlays: { proof: { baseURL: brokerUrl, apiKey: "broker-placeholder" } }, unbound: "engine" })
    await turn(runtime, scope, () => broker.requests.length > 0)
    expect(broker.requests).toHaveLength(1)

    await runtime.bindProviders({ overlays: {}, unbound: "engine" })
    await turn(runtime, scope, () => broker.requests.length > 1)

    expect(broker.requests).toHaveLength(1)
  } finally {
    await runtime.close()
    await broker.close()
    await cleanup()
  }
}, 90_000)

test("a broker refusal reaches the operator in the broker's own words", async () => {

  const message = CREDENTIAL_BROKER_ERRORS.binding_unavailable.message
  const broker = recordingEndpoint({
    status: 403,
    body: JSON.stringify({ error: { code: "binding_unavailable", message } }),
  })
  const brokerUrl = await broker.listen()
  const { root, cleanup } = fixture()
  const { runtime, scope } = engine(root)
  try {
    await runtime.bindProviders({ overlays: { proof: { baseURL: brokerUrl, apiKey: "broker-placeholder" } }, unbound: "engine" })

    const sessionId = await turn(runtime, scope, () => broker.requests.length > 0)
    let failure: string | undefined
    for (let wait = 0; wait < 200 && failure === undefined; wait++) {
      const page = await runtime.sessions.messages(scope, sessionId)
      failure = page.messages.map((row) => JSON.stringify(row.error ?? "")).find((row) => row.includes("HTTP") || row.includes("account"))
      if (failure === undefined) await new Promise((resolve) => setTimeout(resolve, 50))
    }

    expect(failure).toContain(message)
  } finally {
    await runtime.close()
    await broker.close()
    await cleanup()
  }
}, 90_000)

test("a bound provider ignores the apiKey and baseURL its config content carries", async () => {
  const fromConfig = recordingEndpoint()
  const fromBinding = recordingEndpoint()
  const configUrl = await fromConfig.listen()
  const bindingUrl = await fromBinding.listen()
  const { root, cleanup } = fixture()
  const { runtime, scope } = engine(root, { apiKey: "from-config", baseURL: configUrl })
  try {
    await runtime.bindProviders({ overlays: { proof: { baseURL: bindingUrl, apiKey: "placeholder" } }, unbound: "engine" })
    await turn(runtime, scope, () => fromConfig.requests.length + fromBinding.requests.length > 0)
    expect(fromConfig.requests).toEqual([])
    expect(fromBinding.requests).toEqual([{ path: "/v1/chat/completions", authorization: "Bearer placeholder", model: "proof" }])
  } finally {
    await runtime.close()
    await fromConfig.close()
    await fromBinding.close()
    await cleanup()
  }
}, 60_000)

test("a bound provider ignores the apiKey and baseURL the workspace's opencode.json carries", async () => {
  const fromConfig = recordingEndpoint()
  const fromBinding = recordingEndpoint()
  const configUrl = await fromConfig.listen()
  const bindingUrl = await fromBinding.listen()
  const { root, cleanup } = fixture()
  fs.mkdirSync(path.join(root, "work"), { recursive: true })
  fs.writeFileSync(path.join(root, "work", "opencode.json"), JSON.stringify({
    provider: { proof: { options: { apiKey: "from-project-file", baseURL: configUrl } } },
  }))
  const { runtime, scope } = engine(root)
  try {
    await runtime.bindProviders({ overlays: { proof: { baseURL: bindingUrl, apiKey: "placeholder" } }, unbound: "engine" })
    await turn(runtime, scope, () => fromConfig.requests.length + fromBinding.requests.length > 0)
    expect(fromConfig.requests).toEqual([])
    expect(fromBinding.requests).toEqual([{ path: "/v1/chat/completions", authorization: "Bearer placeholder", model: "proof" }])
  } finally {
    await runtime.close()
    await fromConfig.close()
    await fromBinding.close()
    await cleanup()
  }
}, 60_000)

test("a vendor provider the engine only catalogs is enabled by its binding and runs a turn there", async () => {
  const broker = recordingEndpoint()
  const brokerUrl = await broker.listen()
  const { root, cleanup } = fixture()
  const directory = path.join(root, "work")
  fs.mkdirSync(directory, { recursive: true })
  const runtime = createOpenCodeRuntime({ databasePath: path.join(root, "opencode.db") })
  const scope = WorkspaceScope.authorize({ workspaceID: "w", directory })
  try {
    await runtime.bindProviders({ overlays: { openai: { baseURL: brokerUrl, apiKey: "vendor-placeholder" } }, unbound: "disabled" })
    expect((await runtime.catalog.models(scope)).some((model) => model.providerID === "openai" && model.id === "gpt-4.1")).toBe(true)
    const session = await runtime.sessions.create(scope, { title: "vendor" })
    runtime.instances.assign(session.id, runtime.instances.define(scope.directory, { skills: [], mcp: {} }))
    await runtime.sessions.switchModel(scope, session.id, { providerID: "openai", modelID: "gpt-4.1" })
    await runtime.sessions.prompt(scope, session.id, { text: "say hello" })
    for (let wait = 0; wait < 300 && broker.requests.length === 0; wait++) await new Promise((resolve) => setTimeout(resolve, 50))
    expect(broker.requests[0]).toMatchObject({ authorization: "Bearer vendor-placeholder", model: "gpt-4.1" })
  } finally {
    await runtime.close()
    await broker.close()
    await cleanup()
  }
}, 60_000)
