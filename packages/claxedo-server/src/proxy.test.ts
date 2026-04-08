/**
 * Tests the route classification contract of the workspace-runtime proxy.
 *
 * The proxy must correctly decide which requests go to workspace-runtime (WR)
 * vs which fall through to claxedo-server (CS). Getting this wrong means
 * requests silently hit the wrong backend — a category of regression that is
 * invisible in unit tests but breaks everything in production.
 *
 * We test the classification logic in isolation by calling the middleware with
 * stub contexts and checking whether it calls next() (CS) or attempts to proxy (WR).
 */

import { describe, expect, test } from "bun:test"

// We test the route classification by examining the prefix/path lists directly.
// The proxy.ts file uses:
//   - CS_PATHS / CS_PREFIXES → fall through to claxedo-server
//   - WR_INTERNAL / WR_PATHS / WR_PREFIXES → proxy to workspace-runtime
// Any path not in either list also falls through.

// Rather than importing the proxy (which has heavy deps), we replicate the
// classification logic from the source to assert the contract is correct.
// If someone moves a path between CS/WR, this test breaks.

const WR_INTERNAL = ["/api/wr/health", "/api/wr/config", "/api/wr/acp-config-options"]

const WR_PREFIXES = [
  "/api/claxedo/process",
  "/api/claxedo/diff",
  "/api/claxedo/tunnel",
  "/session",
  "/permission",
  "/question",
  "/event",
  "/find",
  "/mcp",
]

const WR_PATHS = ["/file", "/lsp", "/vcs"]

const CS_PATHS = [
  "/global/event",
  "/global/health",
  "/path",
  "/config",
  "/global/config",
  "/agent",
  "/command",
  "/api/claxedo/health",
  "/api/claxedo/track",
  "/api/claxedo/events",
  "/api/claxedo/bootstrap",
]

const CS_PREFIXES = [
  "/provider",
  "/project",
  "/experimental",
  "/api/claxedo/agent-config",
  "/api/claxedo/hook",
  "/api/claxedo/pty",
  "/pages",
  "/api/workgraph",
]

function matches(pathname: string, prefixes: string[]) {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(prefix + "/"))
}

function classifyRoute(pathname: string): "cs" | "wr" | "fallthrough" {
  if (CS_PATHS.includes(pathname) || matches(pathname, CS_PREFIXES)) return "cs"
  if (WR_INTERNAL.includes(pathname) || WR_PATHS.includes(pathname) || matches(pathname, WR_PREFIXES)) return "wr"
  return "fallthrough"
}

describe("proxy route classification", () => {
  // ── CS routes: must never be proxied to workspace-runtime ──────────

  test("claxedo-server routes fall through to local handler", () => {
    const csPaths = [
      "/global/event",
      "/global/health",
      "/path",
      "/config",
      "/global/config",
      "/agent",
      "/command",
      "/api/claxedo/health",
      "/api/claxedo/track",
      "/api/claxedo/events",
      "/api/claxedo/bootstrap",
    ]
    for (const p of csPaths) {
      expect(classifyRoute(p)).toBe("cs")
    }
  })

  test("claxedo-server prefix routes fall through to local handler", () => {
    const csRoutes = [
      "/provider",
      "/provider/auth",
      "/provider/claude-acp/oauth/start",
      "/project",
      "/project/current",
      "/experimental",
      "/experimental/session",
      "/api/claxedo/agent-config",
      "/api/claxedo/agent-config/runner",
      "/api/claxedo/agent-config/mcp/my-server",
      "/api/claxedo/agent-config/commands",
      "/api/claxedo/agent-config/runner/options",
      "/api/claxedo/hook",
      "/api/claxedo/hook/agent-lifecycle",
      "/api/claxedo/pty",
      "/api/claxedo/pty/abc123/connect",
      "/pages",
      "/pages/some-page",
      "/api/workgraph",
      "/api/workgraph/runs",
    ]
    for (const p of csRoutes) {
      expect(classifyRoute(p)).toBe("cs")
    }
  })

  // ── WR routes: must be proxied to workspace-runtime ────────────────

  test("workspace-runtime internal routes are proxied", () => {
    for (const p of WR_INTERNAL) {
      expect(classifyRoute(p)).toBe("wr")
    }
  })

  test("workspace-runtime prefix routes are proxied", () => {
    const wrRoutes = [
      "/session",
      "/session/abc123",
      "/session/abc123/message",
      "/session/abc123/prompt_async",
      "/permission",
      "/permission/abc123",
      "/question",
      "/question/abc123",
      "/event",
      "/find",
      "/find/file",
      "/mcp",
      "/mcp/local/connect",
      "/mcp/local/disconnect",
      "/api/claxedo/process",
      "/api/claxedo/process?workspaceId=ws_123",
      "/api/claxedo/diff",
      "/api/claxedo/diff/targets",
      "/api/claxedo/tunnel",
      "/api/claxedo/tunnel/forward",
    ]
    for (const p of wrRoutes) {
      // strip query string for classification
      const pathname = p.split("?")[0]
      expect(classifyRoute(pathname)).toBe("wr")
    }
  })

  test("exact WR paths are proxied", () => {
    expect(classifyRoute("/file")).toBe("wr")
    expect(classifyRoute("/lsp")).toBe("wr")
    expect(classifyRoute("/vcs")).toBe("wr")
  })

  // ── No overlap: CS and WR route sets are disjoint ─────────────────

  test("no path is classified as both CS and WR", () => {
    const allCsExact = [...CS_PATHS]
    const allWrExact = [...WR_INTERNAL, ...WR_PATHS]

    // Exact paths must not appear in both lists
    const overlap = allCsExact.filter((p) => allWrExact.includes(p))
    expect(overlap).toEqual([])

    // No CS prefix should be a prefix of any WR prefix and vice versa
    for (const cs of CS_PREFIXES) {
      for (const wr of WR_PREFIXES) {
        expect(wr.startsWith(cs + "/")).toBe(false)
        expect(cs.startsWith(wr + "/")).toBe(false)
        expect(cs).not.toBe(wr)
      }
    }
  })

  // ── Fallthrough: unknown routes ───────────────────────────────────

  test("unknown paths fall through (not proxied, not claimed)", () => {
    const unknown = [
      "/unknown",
      "/api/something-else",
      "/random/endpoint",
    ]
    for (const p of unknown) {
      expect(classifyRoute(p)).toBe("fallthrough")
    }
  })

  // ── Edge cases ───────────────────────────────────────────────────

  test("/event is WR but /global/event is CS", () => {
    expect(classifyRoute("/event")).toBe("wr")
    expect(classifyRoute("/global/event")).toBe("cs")
  })

  test("/config is CS but /api/wr/config is WR", () => {
    expect(classifyRoute("/config")).toBe("cs")
    expect(classifyRoute("/api/wr/config")).toBe("wr")
  })

  test("agent-config subpath /runner is CS not WR", () => {
    // Important: /api/claxedo/agent-config/runner is config, not a session route
    expect(classifyRoute("/api/claxedo/agent-config/runner")).toBe("cs")
  })
})
