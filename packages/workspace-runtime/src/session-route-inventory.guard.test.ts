import { describe, expect, test } from "bun:test"
import fs from "node:fs"

function source(relative: string) {
  return fs.readFileSync(new URL(relative, import.meta.url), "utf8")
}

function declaredRoutes(input: string, methods: readonly string[]) {
  const allowed = new Set(methods.map((method) => method.toLowerCase()))
  return [...input.matchAll(/\.(get|post|put|patch|delete|all)\(\s*"([^"]+)"/g)]
    .filter((match) => allowed.has(match[1].toLowerCase()) && match[2].startsWith("/"))
    .map((match) => `${match[1].toUpperCase()} ${match[2]}`)
    .sort()
}

function uniqueDeclaredRoutes(input: string) {
  return [...new Set(declaredRoutes(input, ["get", "post", "put", "patch", "delete", "all"]))].sort()
}

describe("private-session route inventory", () => {
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
      "./routes/pty.ts": [
        "DELETE /:ptyID",
        "GET /",
        "GET /:ptyID",
        "GET /agents",
        "GET /:ptyID/connect",
        "POST /",
        "PUT /:ptyID",
      ],
      "./routes/worktree.ts": ["GET /", "GET /:sessionId", "POST /"],
    }

    for (const [relative, routes] of Object.entries(expected)) {
      expect(uniqueDeclaredRoutes(source(relative))).toEqual(routes.sort())
    }
  })

  test("direct host routes cannot grow around the classified session router", () => {
    expect(uniqueDeclaredRoutes(source("./workspace/runtime.ts") + source("./workspace/vcs.ts"))).toEqual([
      "GET /api/wr/harness-config-options",
      "GET /api/wr/harness-providers",
      "GET /vcs",
    ])
  })
})
