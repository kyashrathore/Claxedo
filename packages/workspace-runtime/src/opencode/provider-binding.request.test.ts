/**
 * Where a bound provider's requests actually go, and what they carry.
 *
 * The catalog assertions next door say a provider is listed or disabled; they
 * pass whether or not a turn ever reaches the broker. These run the engine's
 * own turn against a recording endpoint and read the request it made.
 */
import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createServer } from "node:http"
import { CREDENTIAL_BROKER_ERRORS } from "@claxedo/agent-runtime-contract"
import { createOpenCodeRuntime, type OpenCodeRuntime } from "./runtime"
import { WorkspaceScope } from "./scope"

type Recorded = { path: string; authorization?: string; model: unknown }

/** An endpoint that records what reached it and answers as an OpenAI-compatible model. */
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

/**
 * `options` names no `baseURL` or `apiKey`, because a provider whose config
 * carries either keeps it: the engine merges the config over every plugin's
 * catalog transform, per key. A binding is the only routing this provider has.
 */
function engine(root: string): { runtime: OpenCodeRuntime; scope: WorkspaceScope } {
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
          },
        },
      }),
    }),
    scope: WorkspaceScope.authorize({ workspaceID: "w", directory }),
  }
}

async function turn(runtime: OpenCodeRuntime, scope: WorkspaceScope, until: () => boolean) {
  const session = await runtime.sessions.create(scope, { title: "routing" })
  await runtime.sessions.switchModel(scope, session.id, { providerID: "proof", modelID: "proof" })
  await runtime.sessions.prompt(scope, session.id, { text: "say hello" })
  for (let wait = 0; wait < 300 && !until(); wait++) await new Promise((resolve) => setTimeout(resolve, 50))
  return session.id
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-binding-request-"))
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

test("a bound provider's request reaches the binding and carries its placeholder", async () => {
  const broker = recordingEndpoint()
  const brokerUrl = await broker.listen()
  const { root, cleanup } = fixture()
  const { runtime, scope } = engine(root)
  try {
    await runtime.bindProviders({ proof: { baseURL: brokerUrl, apiKey: "broker-placeholder" } })

    await turn(runtime, scope, () => broker.requests.length > 0)

    expect(broker.requests).not.toHaveLength(0)
    expect(broker.requests[0]?.path).toBe("/v1/chat/completions")
    // The placeholder, not a stored key: the broker is what turns it into the
    // operator's own credential, and this process never holds that.
    expect(broker.requests[0]?.authorization).toBe("Bearer broker-placeholder")
    expect(broker.requests[0]?.model).toBe("proof")
  } finally {
    await runtime.close()
    await broker.close()
    cleanup()
  }
}, 60_000)

test("a withdrawn account sends nothing to the binding it used to name", async () => {
  const broker = recordingEndpoint()
  const brokerUrl = await broker.listen()
  const { root, cleanup } = fixture()
  const { runtime, scope } = engine(root)
  try {
    await runtime.bindProviders({ proof: { baseURL: brokerUrl, apiKey: "broker-placeholder" } })
    await turn(runtime, scope, () => broker.requests.length > 0)
    expect(broker.requests).toHaveLength(1)

    await runtime.bindProviders({ proof: { unavailable: true, reason: "auth_failed" } })
    await turn(runtime, scope, () => broker.requests.length > 1)

    // Not one more request on the withdrawn account's binding.
    expect(broker.requests).toHaveLength(1)
    expect(runtime.providerUnavailableReason("proof")).toBe("auth_failed")
  } finally {
    await runtime.close()
    await broker.close()
    cleanup()
  }
}, 90_000)

test("a provider nobody bound sends nothing to the broker", async () => {
  const broker = recordingEndpoint()
  const brokerUrl = await broker.listen()
  const { root, cleanup } = fixture()
  const { runtime, scope } = engine(root)
  try {
    await runtime.bindProviders({ proof: { baseURL: brokerUrl, apiKey: "broker-placeholder" } })
    await turn(runtime, scope, () => broker.requests.length > 0)
    expect(broker.requests).toHaveLength(1)

    await runtime.bindProviders({})
    await turn(runtime, scope, () => broker.requests.length > 1)

    // Unbound is the engine's own auth, which for this provider is no endpoint
    // at all — never the binding a previous selection named.
    expect(broker.requests).toHaveLength(1)
  } finally {
    await runtime.close()
    await broker.close()
    cleanup()
  }
}, 90_000)

test("a broker refusal reaches the operator in the broker's own words", async () => {
  // The engine decodes `{ error: { message } }` and shows nothing else, so a
  // body it cannot read leaves the operator with a bare HTTP status for the one
  // failure they can act on.
  // The body the broker sends, in the shape `@claxedo/egress-broker`'s
  // `brokerErrorBody` builds it; that package's own test pins the shape, this
  // one pins what the engine does with it.
  const message = CREDENTIAL_BROKER_ERRORS.binding_unavailable.message
  const broker = recordingEndpoint({
    status: 403,
    body: JSON.stringify({ error: { code: "binding_unavailable", message } }),
  })
  const brokerUrl = await broker.listen()
  const { root, cleanup } = fixture()
  const { runtime, scope } = engine(root)
  try {
    await runtime.bindProviders({ proof: { baseURL: brokerUrl, apiKey: "broker-placeholder" } })

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
    cleanup()
  }
}, 90_000)
