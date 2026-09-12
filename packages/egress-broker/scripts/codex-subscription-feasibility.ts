import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { createGenericDeliveryAdapter, verifyRuntimeToken, type Binding } from "../src/index.js"
import { listenLoopbackBroker } from "../src/node.js"
import { CodexAppServerProcess } from "../../agent-sdk-runtime/src/harnesses/codex/app-server-process.ts"
import { asRecord, asString } from "../../claxedo-helpers/src/guards.ts"

const authPath = process.env.BROKER_CODEX_AUTH_FILE
const binary = process.env.BROKER_CODEX_BINARY
const model = process.env.BROKER_CODEX_MODEL
assert.ok(authPath && binary && model, "Set BROKER_CODEX_AUTH_FILE, BROKER_CODEX_BINARY, and BROKER_CODEX_MODEL")
const auth = JSON.parse(await fs.readFile(authPath, "utf8"))
const value = auth.tokens?.access_token
assert.equal(typeof value, "string", "A subscription access token is required")
assert.ok(value.length > 0)
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-broker-proof-"))
const signingKey = randomBytes(32)
const failures: unknown[] = []
const statuses: number[] = []
let unavailableBindings = 0
const adapter = createGenericDeliveryAdapter({ signingKey, reportFailure: async (failure) => { failures.push(failure) } })
const binding: Binding = {
  id: "subscription", credentialId: "test-subscription", revision: 1, status: "active",
  userId: "test-user", orgId: "test-org", workspaceId: "test-workspace", leaseId: "test-lease", leaseGeneration: 1, runtimeId: "test-runtime",
  destination: { origin: "https://chatgpt.com", methods: ["POST"], pathPrefixes: ["/backend-api/codex/responses"] },
  injection: { header: "authorization", scheme: "Bearer" },
}
adapter.activateRuntime(binding)
adapter.apply(binding, value)
const broker = await listenLoopbackBroker({
  authority: { ...adapter.authority, resolve: async (id) => {
    const entry = await adapter.authority.resolve(id)
    if (!entry) unavailableBindings++
    return entry
  } },
  verifyToken: (token) => verifyRuntimeToken(token, signingKey),
  fetch: async (url, init) => { const response = await fetch(url, init); statuses.push(response.status); return response },
})
let proc: CodexAppServerProcess | undefined
async function runTurn(process: CodexAppServerProcess, threadId: string, expectedStatus: "completed" | "failed") {
  let text = ""
  let stop = () => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  const completed = new Promise<string>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Codex turn timed out")), 90_000)
    stop = process.onMessage((message) => {
      const params = asRecord(message.params)
      const item = asRecord(params?.item)
      const turn = asRecord(params?.turn)
      if (message.method === "item/completed" && item?.type === "agentMessage") text += asString(item.text) ?? ""
      if (message.method === "turn/completed") {
        if (turn?.status === expectedStatus) resolve(text)
        else reject(new Error(`Unexpected Codex turn status: ${JSON.stringify(turn)}`))
      }
    })
  })
  void completed.catch(() => {})
  try {
    await process.request("turn/start", { threadId, input: [{ type: "text", text: "Reply with exactly BROKER_OK. Do not use tools." }] })
    return await completed
  } finally {
    if (timer) clearTimeout(timer)
    stop()
  }
}
async function assertNoCredentialFiles(root: string): Promise<void> {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) await assertNoCredentialFiles(file)
    else if (entry.isFile()) assert.ok(!(await fs.readFile(file)).includes(Buffer.from(value)), "A runtime file contains the real credential")
  }
}
try {
  const projection = await adapter.project(binding.id, broker.origin, Date.now() + 180_000)
  await fs.writeFile(path.join(directory, "config.toml"), [
    `model = ${JSON.stringify(model)}`, 'model_provider = "broker"', 'sandbox_mode = "read-only"',
    '[model_providers.broker]', 'name = "Broker feasibility"',
    `base_url = ${JSON.stringify(`${projection.baseUrl}/backend-api/codex`)}`,
    'wire_api = "responses"', 'requires_openai_auth = false',
    `http_headers = { Authorization = ${JSON.stringify(`Bearer ${projection.placeholder}`)} }`,
  ].join("\n"))
  proc = await CodexAppServerProcess.start({
    binary, directory,
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, CODEX_HOME: directory },
    requestHandler: async () => { throw new Error("Interactive requests are not allowed in this feasibility test") },
    signal: AbortSignal.timeout(30_000),
  })
  const started = asRecord(await proc.request("thread/start", { cwd: directory, model, modelProvider: "broker", sandbox: "read-only", approvalPolicy: "untrusted" }))
  const threadId = asString(asRecord(started?.thread)?.id)
  assert.ok(threadId, "Codex did not return a thread id")
  const text = await runTurn(proc, threadId, "completed")
  assert.ok(text.includes("BROKER_OK"), "Expected the requested subscription response")
  assert.ok(statuses.includes(200), `No successful upstream response: ${statuses.join(", ")}`)
  assert.deepEqual(failures, [])
  const upstreamRequests = statuses.length
  adapter.withdraw(binding.id, 2)
  await runTurn(proc, threadId, "failed")
  assert.equal(statuses.length, upstreamRequests, "Withdrawn binding reached the upstream")
  assert.ok(unavailableBindings > 0, "The second turn did not reach the withdrawn binding")
  await proc.dispose()
  await assertNoCredentialFiles(directory)
  console.log(JSON.stringify({ ok: true, model, upstreamStatuses: statuses, rawCredentialInRuntimeFiles: false, withdrawalBlockedExistingClient: true }))
} catch (error) {
  // The broker hands the real subscription token to the upstream request, so a
  // failure message or stack can contain it. The caught error is scrubbed in
  // place because it is re-thrown as the cause and printed with the chain.
  if (error instanceof Error) {
    error.message = error.message.split(value).join("[REDACTED]")
    if (error.stack) error.stack = error.stack.split(value).join("[REDACTED]")
  }
  throw new Error(String(error).split(value).join("[REDACTED]"), { cause: error })
} finally {
  await proc?.dispose()
  await broker.close()
  adapter.dispose()
  await fs.rm(directory, { recursive: true, force: true })
}
