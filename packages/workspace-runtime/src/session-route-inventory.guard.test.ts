import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import {
  SESSION_CORE_ROUTE_ACCESS,
  SESSION_V2_PROXY_ROUTE_ACCESS,
} from "./session-access-policy"

function source(relative: string) {
  return fs.readFileSync(new URL(relative, import.meta.url), "utf8")
}

function declaredRoutes(input: string, methods: readonly string[]) {
  const allowed = new Set(methods.map((method) => method.toLowerCase()))
  return [...input.matchAll(/\.(get|post|put|patch|delete|all)\(\s*"([^"]+)"/g)]
    .filter((match) => allowed.has(match[1]!.toLowerCase()) && match[2]!.startsWith("/"))
    .map((match) => `${match[1]!.toUpperCase()} ${match[2]!}`)
    .sort()
}

function uniqueDeclaredRoutes(input: string) {
  return [...new Set(declaredRoutes(input, ["get", "post", "put", "patch", "delete", "all"]))].sort()
}

describe("private-session route inventory", () => {
  test("every session-core route has an explicit access classification", () => {
    expect(declaredRoutes(source("./routes/session-core.ts"), ["get", "post", "put", "patch", "delete"]))
      .toEqual(Object.keys(SESSION_CORE_ROUTE_ACCESS).sort())
  })

  test("every Session V2 proxy mount has an explicit access classification", () => {
    const sessionProxyRoutes = declaredRoutes(source("./workspace/runtime.ts"), ["all"])
      .filter((route) => route.startsWith("ALL /api/session"))
    expect(sessionProxyRoutes).toEqual(Object.keys(SESSION_V2_PROXY_ROUTE_ACCESS).sort())
  })

  test("sensitive peripheral route families cannot grow without an inventory decision", () => {
    const expected: Record<string, string[]> = {
      "./routes/agent-hook.ts": [
        "GET /agent-lifecycle",
        "GET /setup/status",
        "GET /terminal-env",
        "GET /terminal-session",
        "POST /agent-lifecycle",
        "POST /setup",
      ],
      "./routes/checkpoint.ts": [
        "GET /",
        "POST /flush",
        "POST /freeze",
        "POST /restore-reconcile",
        "POST /resume",
        "POST /scrub",
      ],
      "./routes/document-hydration.ts": [
        "POST /api/wr/documents/:sessionId/:documentId/activate",
        "POST /api/wr/documents/:sessionId/:documentId/resolve",
        "POST /api/wr/documents/hydrate",
      ],
      "./routes/process.ts": [
        "DELETE /:id",
        "GET /",
        "GET /logs",
        "GET /port-map",
        "POST /",
        "POST /:id/restart",
        "POST /:id/start",
        "POST /:id/stop",
        "POST /start-all",
        "POST /stop-all",
        "PUT /:id",
      ],
      "./routes/pty.ts": [
        "DELETE /:ptyID",
        "GET /",
        "GET /:ptyID",
        "GET /:ptyID/connect",
        "POST /",
        "PUT /:ptyID",
      ],
      "./routes/session-env.ts": [
        "GET /file/exists",
        "GET /file/read",
        "GET /file/readdir",
        "GET /file/stat",
        "POST /exec",
        "POST /file/access",
        "POST /file/mkdir",
        "POST /file/rm",
        "POST /file/write",
        "POST /glob",
        "POST /grep",
      ],
      "./routes/transcript.ts": ["GET /:handle"],
      "./routes/worktree.ts": ["GET /", "GET /:sessionId", "POST /"],
    }

    for (const [relative, routes] of Object.entries(expected)) {
      expect(uniqueDeclaredRoutes(source(relative))).toEqual(routes.sort())
    }
  })

  test("direct host routes cannot grow around the classified session router", () => {
    expect(uniqueDeclaredRoutes(source("./workspace/runtime.ts"))).toEqual([
      "ALL /api/model",
      "ALL /api/session",
      "ALL /api/session/*",
      "GET /api/wr/harness-config-options",
      "GET /experimental/tool/ids",
      "GET /global/event",
      "GET /lsp",
      "GET /mcp",
      "GET /provider",
      "GET /vcs",
      "POST /mcp/:name/connect",
      "POST /mcp/:name/disconnect",
    ])
  })
})
