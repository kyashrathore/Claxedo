import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import { hostedWorkerCompatibility, wranglerBundle } from "../test-support/hosted-worker-bundle"

const FIXTURE_WORKER = fileURLToPath(new URL("./fixtures/mcp-endpoint-worker.fixture.ts", import.meta.url))

let miniflare: Miniflare

beforeAll(async () => {
  miniflare = new Miniflare({
    ...hostedWorkerCompatibility(),
    modules: [{ type: "ESModule", path: "worker.js", contents: wranglerBundle(FIXTURE_WORKER) }],
  })
}, 180_000)

afterAll(async () => {
  await miniflare?.dispose()
})

function rpc(method: string, params: Record<string, unknown>) {
  return miniflare.dispatchFetch("https://api.test/", {
    method: "POST",
    headers: { authorization: "Bearer fixture-runtime", "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
}

test("a bundled isolate loads the MCP SDK with its first MCP request and answers it", async () => {
  const initialized = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "workerd", version: "0" } })
  expect(initialized.status).toBe(200)
  expect(((await initialized.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("claxedo")

  const listed = await rpc("tools/list", {})
  expect(listed.status).toBe(200)
  const tools = ((await listed.json()) as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name)
  expect(tools.length).toBeGreaterThan(0)
})
