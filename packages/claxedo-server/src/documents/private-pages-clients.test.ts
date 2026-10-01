import { afterEach, expect, test, vi } from "vitest"
import { documents } from "../../../cli/src/commands/documents"
import { registerDocumentTools } from "../../../claxedo-mcp/src/tools/documents"
import type { ToolRegistrar, McpToolHandler } from "../../../claxedo-mcp/src/tools/registry"
import type { McpToolContext } from "../../../claxedo-mcp/src/context"
import { privatePagesFixture } from "./private-pages-fixture"

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

test("CLI checks edit authorization before requesting a writable path", async () => {
  const f = privatePagesFixture(); const page = await f.create(); f.share(page.id, "person", "member", "view")
  const paths: string[] = []
  vi.stubEnv("CLAXEDO_CONTROL_PLANE_URL", "https://control.test")
  vi.stubEnv("CLAXEDO_ACCESS_TOKEN", "member")
  vi.stubEnv("CLAXEDO_HOME", `${process.env.CLAXEDO_DATA_DIR}/cli`)
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input)); paths.push(url.pathname)
    return await f.request("member", `${url.pathname}${url.search}`, init?.method, init?.body ? JSON.parse(String(init.body)) : undefined)
  })
  await expect(documents(["open", page.id, "--project", "project", "--session", "session"])).rejects.toThrow("Document not found")
  expect(paths).toEqual(["/documents", `/documents/${page.id}/authorization`])
})

test("MCP checks edit authorization before requesting a writable path", async () => {
  const f = privatePagesFixture(); const page = await f.create(); f.share(page.id, "person", "member", "view")
  const handlers = new Map<string, McpToolHandler<any>>()
  registerDocumentTools({ tool: (name: string, _definition: unknown, handler: McpToolHandler<any>) => { handlers.set(name, handler) } } as ToolRegistrar)
  const paths: string[] = []
  const context = {
    credential: { kind: "user", actorId: "member", scopes: new Set(["read", "act"]), clientId: "test", readOnly: false },
    client: { documents: async (path: string, init?: RequestInit) => {
      paths.push(path.split("?")[0])
      return await f.request("member", path, init?.method, init?.body ? JSON.parse(String(init.body)) : undefined)
    } }, audit: () => {},
  } as unknown as McpToolContext
  const result = await handlers.get("documents_open")!({ document: page.id, project: "project", session: "session" }, context)
  expect(result.isError).toBe(true)
  expect(paths).toEqual(["/documents", `/documents/${page.id}/authorization`])
})
