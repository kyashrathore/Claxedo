import { createServer } from "node:http"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { expect, test } from "vitest"

test("spawn_session requires a machine and reports the actual initial prompt admission outcome", async () => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = []
  let rejectPrompt = false
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}")
    requests.push({ path: new URL(request.url!, "http://fixture").pathname, body })
    response.setHeader("content-type", "application/json")
    if (request.url?.includes("prompt_async")) {
      response.statusCode = rejectPrompt ? 403 : 202
      response.end(JSON.stringify(rejectPrompt ? { error: { code: "session_forbidden", message: "private session denied" } } : { status: "admitted", sessionId: "canonical-session" }))
    } else response.end(JSON.stringify({ session: { id: "canonical-session" } }))
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing test address")
  const client = new Client({ name: "dispatch-contract", version: "1" })
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", createRequire(import.meta.url).resolve("tsx"), fileURLToPath(new URL("./server.ts", import.meta.url))], cwd: tmpdir(), env: { CLAXEDO_SERVER_URL: `http://127.0.0.1:${address.port}`, CLAXEDO_API_DIR: "/repo", CLAXEDO_AUTH_TOKEN: "", CLAXEDO_MCP_READ_ONLY: "0" }, stderr: "pipe" }))
    const tools = await client.listTools()
    expect(tools.tools.find(tool => tool.name === "spawn_session")?.inputSchema.required).toEqual(expect.arrayContaining(["workspace_id", "harness"]))
    const result = await client.callTool({ name: "spawn_session", arguments: { workspace_id: "workspace", harness: "pi", prompt: "Write a file" } })
    expect(result.isError).not.toBe(true)
    const content = result.content as Array<{ text: string }>
    expect(JSON.parse(content[0]!.text)).toMatchObject({ session_id: "canonical-session", workspace_id: "workspace", delivery: { status: "admitted" } })
    expect(requests[0]).toMatchObject({ path: "/api/control/sessions", body: { workspaceId: "workspace", harness: "pi" } })
    expect(requests[1]!.path).toContain("canonical-session/prompt_async")
    expect(requests[1]!.body.messageID).toMatch(/^mcp:/)
    rejectPrompt = true
    expect((await client.callTool({ name: "spawn_session", arguments: { workspace_id: "workspace", harness: "pi", prompt: "Denied" } })).isError).toBe(true)
    expect(requests).toHaveLength(4)
  } finally {
    await client.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
