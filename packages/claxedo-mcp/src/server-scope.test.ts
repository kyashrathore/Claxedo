import { createServer } from "node:http"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { expect, test } from "vitest"

test("stdio process tool uses the canonical configured directory and permits explicit override", async () => {
  const requests: Array<{ path: string; directory: string | null; header: string | string[] | undefined }> = []
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://fixture")
    requests.push({
      path: url.pathname,
      directory: url.searchParams.get("directory"),
      header: request.headers["x-claxedo-directory"],
    })
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ configs: [], processes: [] }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected ephemeral HTTP address")
  const client = new Client({ name: "scope-regression", version: "1" })
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          "--import",
          createRequire(import.meta.url).resolve("tsx"),
          fileURLToPath(new URL("./server.ts", import.meta.url)),
        ],
        cwd: tmpdir(),
        env: {
          CLAXEDO_SERVER_URL: `http://127.0.0.1:${address.port}`,
          CLAXEDO_API_DIR: "/test/canonical-project",
          OPENCODE_API_DIR: "/test/obsolete-project",
          CLAXEDO_WORKSPACE_ID: "",
          CLAXEDO_AUTH_TOKEN: "",
          CLAXEDO_MCP_READ_ONLY: "0",
        },
        stderr: "pipe",
      }),
    )
    for (const directory of [undefined, "/test/explicit-project"]) {
      const result = await client.callTool({
        name: "process",
        arguments: { action: "list", ...(directory ? { directory } : {}) },
      })
      expect(result.isError).not.toBe(true)
    }
    expect(requests).toEqual([
      { path: "/api/wr/process", directory: "/test/canonical-project", header: "/test/canonical-project" },
      { path: "/api/wr/process", directory: "/test/explicit-project", header: "/test/explicit-project" },
    ])
  } finally {
    await client.close()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})
