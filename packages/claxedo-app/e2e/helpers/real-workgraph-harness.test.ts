import { afterEach, describe, expect, test } from "vitest"
import { request as httpRequest } from "node:http"
import { request as playwrightRequest } from "@playwright/test"
import type { CommandResult, ExecutionCapabilities } from "@claxedo/workgraph/contracts"
import { WorkGraphConnectionToolNames } from "@claxedo/workgraph/contracts"
import { createRealWorkGraphHarness, type RealWorkGraphHarness } from "./real-workgraph-harness"

let harness: RealWorkGraphHarness | undefined

afterEach(async () => {
  await harness?.close()
  harness = undefined
})

describe("real WorkGraph HTTP harness", () => {
  test("isolates the same user across organizations and publishes only live organization capabilities", async () => {
    harness = await createRealWorkGraphHarness({
      port: 0,
      organizationId: "organization-a",
      ownerUserId: "same-user",
      trustedAuthContexts: {
        "token-organization-a": { organizationId: "organization-a", ownerUserId: "same-user" },
        "token-organization-b": { organizationId: "organization-b", ownerUserId: "same-user" },
      },
    })

    const first = await command("token-organization-a", "Organization A launch")
    const second = await command("token-organization-b", "Organization B launch")
    expect(first.value).not.toEqual(second.value)

    expect((await snapshot("token-organization-a")).records.filter((record) => record.recordType === "stream").map((record) => record.title)).toEqual(["Organization A launch"])
    expect((await snapshot("token-organization-b")).records.filter((record) => record.recordType === "stream").map((record) => record.title)).toEqual(["Organization B launch"])

    const firstCapabilities = await capabilities("token-organization-a")
    const secondCapabilities = await capabilities("token-organization-b")
    expect(firstCapabilities).toMatchObject({
      organizationId: "organization-a",
      ownerUserId: "same-user",
      harnesses: [{ id: "opencode" }],
      agents: [{ harnessId: "opencode", id: "build" }],
      models: [{ harnessId: "opencode", providerId: "openai", modelId: "gpt-5", efforts: ["high"] }],
      repository: { baseRevisions: ["HEAD", "dev"] },
      connections: [{ id: harness.connectionEvidence().connectionId, integrationId: "github", scope: "team" }],
    })
    expect(firstCapabilities.tools.map((tool) => tool.id)).toEqual(["read", "edit", ...WorkGraphConnectionToolNames])
    expect(secondCapabilities).toMatchObject({
      organizationId: "organization-b",
      ownerUserId: "same-user",
      connections: [],
    })
    expect(secondCapabilities.tools.map((tool) => tool.id)).toEqual(["read", "edit"])

    const visible = await fetch(`${harness.apiUrl}/api/workgraph/source-views`, {
      method: "POST",
      headers: headers("token-organization-a"),
      body: JSON.stringify({
        teamConnectionId: harness.connectionEvidence().connectionId,
        provider: "github",
        providerUserId: "octocat",
        filters: { repo: "claxedo/claxedo" },
      }),
    })
    expect(visible.status).toBe(201)
    const hidden = await fetch(`${harness.apiUrl}/api/workgraph/source-views`, {
      method: "POST",
      headers: headers("token-organization-b"),
      body: JSON.stringify({
        teamConnectionId: harness.connectionEvidence().connectionId,
        provider: "github",
        providerUserId: "octocat",
        filters: { repo: "claxedo/claxedo" },
      }),
    })
    expect(hidden.status).toBe(409)
    expect(await hidden.json()).toEqual({
      error: {
        code: "source_view_connection_unavailable",
        message: "Source View Connection is unavailable",
        retryable: false,
      },
    })
  })

  test("translates a client disconnect into request cancellation rather than a harness failure", async () => {
    harness = await createRealWorkGraphHarness({ port: 0 })
    const held = await holdRequest(harness.apiUrl)
    harness.assertHealthy()

    const disconnected = new Promise<void>((resolve) => held.once("close", resolve))
    held.on("error", () => undefined)
    held.destroy()
    await disconnected
    // The harness translates the disconnect into an AbortController cancellation.
    // Had it instead surfaced the aborted read as a real error, `respond` would
    // have rejected, `capture` would have recorded it, and both of the following
    // would throw.
    await new Promise((resolve) => setTimeout(resolve, 50))
    harness.assertHealthy()

    await harness.close()
    harness = undefined
  })

  test("cancels an admitted in-flight request when the harness owns teardown", async () => {
    harness = await createRealWorkGraphHarness({ port: 0 })
    await holdRequest(harness.apiUrl)

    const closing = harness.close()
    expect(await Promise.race([
      closing.then(() => "closed" as const),
      new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 500)),
    ])).toBe("closed")
    await closing
    harness = undefined
  })

  test("closes sockets retained by Playwright's request context", async () => {
    harness = await createRealWorkGraphHarness({ port: 0 })
    const client = await playwrightRequest.newContext()
    try {
      expect((await client.get(`${harness.apiUrl}/api/claxedo/health`)).ok()).toBe(true)

      const closing = harness.close()
      expect(await Promise.race([
        closing.then(() => "closed" as const),
        new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 500)),
      ])).toBe("closed")
      await closing
      harness = undefined
    } finally {
      await client.dispose()
    }
  })
})

// The `/changes` long-poll is gone (plan 2026-07-17-004), so nothing the harness
// serves stays open on its own. These teardown properties are still real, so hold
// a request open the only way left: announce a body and never send it. The server
// admits the request, parks in `readIncomingBody`, and stays in `activeRequests` —
// exactly the in-flight state the long poll used to create.
async function holdRequest(apiUrl: string) {
  const held = httpRequest(`${apiUrl}/api/workgraph/commands`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": "1024" },
  })
  await new Promise<void>((resolve, reject) => {
    held.once("socket", (socket) => socket.once("connect", resolve))
    held.once("error", reject)
    held.flushHeaders()
  })
  // Let the server parse the headers, admit the request, and park on the body.
  await new Promise((resolve) => setTimeout(resolve, 50))
  return held
}

async function command(token: string, title: string) {
  const response = await fetch(`${harness!.apiUrl}/api/workgraph/commands`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      operationId: "same-operation-id",
      command: { version: 1, type: "create_stream", title },
    }),
  })
  const result = await response.json() as CommandResult
  if (!response.ok || !result.ok) throw new Error(result.ok ? `WorkGraph command failed with ${response.status}` : result.error.message)
  return result
}

async function snapshot(token: string) {
  const response = await fetch(`${harness!.apiUrl}/api/workgraph/snapshot`, { headers: headers(token) })
  if (!response.ok) throw new Error(`WorkGraph snapshot failed with ${response.status}: ${await response.text()}`)
  return await response.json() as { records: Array<{ recordType: string; title?: string }> }
}

async function capabilities(token: string) {
  const response = await fetch(`${harness!.apiUrl}/api/workgraph/execution-capabilities`, { headers: headers(token) })
  if (!response.ok) throw new Error(`WorkGraph capabilities failed with ${response.status}: ${await response.text()}`)
  return await response.json() as ExecutionCapabilities
}

function headers(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" }
}
