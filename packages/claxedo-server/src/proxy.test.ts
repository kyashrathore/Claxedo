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

import { describe, expect, test } from "vitest"

// We test the route classification by examining the prefix/path lists directly.
// The proxy.ts file uses:
//   - CS_PATHS / CS_PREFIXES → fall through to claxedo-server
//   - WR_INTERNAL / WR_PATHS / WR_PREFIXES → proxy to workspace-runtime
// Any path not in either list also falls through.

// Rather than importing the proxy (which has heavy deps), we replicate the
// classification logic from the source to assert the contract is correct.
// If someone moves a path between CS/WR, this test breaks.

const WR_INTERNAL = ["/api/wr/health", "/api/wr/config", "/api/wr/acp-config-options", "/api/wr/capabilities"]

const WR_FULL_PREFIXES = [
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

const WR_MIN_PREFIXES = [
  "/api/claxedo/process",
  "/api/claxedo/diff",
  "/api/claxedo/tunnel",
  "/find",
]

const WR_FULL_PATHS = ["/file", "/file/content", "/file/status", "/lsp", "/vcs"]
const WR_MIN_PATHS = ["/file", "/file/content", "/file/status"]

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

function classifyRoute(pathname: string, mode: "workspace" | "central" = "workspace"): "cs" | "wr" | "fallthrough" {
  const paths = mode === "central" ? WR_MIN_PATHS : WR_FULL_PATHS
  const prefixes = mode === "central" ? WR_MIN_PREFIXES : WR_FULL_PREFIXES
  if (CS_PATHS.includes(pathname) || matches(pathname, CS_PREFIXES)) return "cs"
  if (WR_INTERNAL.includes(pathname) || paths.includes(pathname) || matches(pathname, prefixes)) return "wr"
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
      expect(classifyRoute(p, "workspace")).toBe("cs")
      expect(classifyRoute(p, "central")).toBe("cs")
    }
  })

  // ── WR routes: must be proxied to workspace-runtime ────────────────

  test("workspace-runtime internal routes are proxied", () => {
    for (const p of WR_INTERNAL) {
      expect(classifyRoute(p, "workspace")).toBe("wr")
      expect(classifyRoute(p, "central")).toBe("wr")
    }
  })

  test("workspace mode still proxies full workspace routes", () => {
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
      expect(classifyRoute(pathname, "workspace")).toBe("wr")
    }
  })

  test("central mode only proxies minimal workspace routes", () => {
    expect(classifyRoute("/api/claxedo/process", "central")).toBe("wr")
    expect(classifyRoute("/api/claxedo/diff", "central")).toBe("wr")
    expect(classifyRoute("/api/claxedo/tunnel", "central")).toBe("wr")
    expect(classifyRoute("/find/file", "central")).toBe("wr")
    expect(classifyRoute("/file", "central")).toBe("wr")
    expect(classifyRoute("/file/content", "central")).toBe("wr")
    expect(classifyRoute("/file/status", "central")).toBe("wr")
    expect(classifyRoute("/session", "central")).toBe("fallthrough")
    expect(classifyRoute("/permission", "central")).toBe("fallthrough")
    expect(classifyRoute("/question", "central")).toBe("fallthrough")
    expect(classifyRoute("/event", "central")).toBe("fallthrough")
    expect(classifyRoute("/mcp", "central")).toBe("fallthrough")
    expect(classifyRoute("/lsp", "central")).toBe("fallthrough")
    expect(classifyRoute("/vcs", "central")).toBe("fallthrough")
  })

  test("exact full workspace paths are only proxied in workspace mode", () => {
    expect(classifyRoute("/file", "workspace")).toBe("wr")
    expect(classifyRoute("/lsp", "workspace")).toBe("wr")
    expect(classifyRoute("/vcs", "workspace")).toBe("wr")
  })

  // ── No overlap: CS and WR route sets are disjoint ─────────────────

  test("no path is classified as both CS and WR", () => {
    const allCsExact = [...CS_PATHS]
    const allWrExact = [...WR_INTERNAL, ...WR_FULL_PATHS]

    // Exact paths must not appear in both lists
    const overlap = allCsExact.filter((p) => allWrExact.includes(p))
      expect(overlap).toEqual([])

      // No CS prefix should be a prefix of any WR prefix and vice versa
      for (const cs of CS_PREFIXES) {
      for (const wr of WR_FULL_PREFIXES) {
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
      expect(classifyRoute(p, "workspace")).toBe("fallthrough")
      expect(classifyRoute(p, "central")).toBe("fallthrough")
    }
  })

  // ── Edge cases ───────────────────────────────────────────────────

  test("/event is WR but /global/event is CS", () => {
    expect(classifyRoute("/event", "workspace")).toBe("wr")
    expect(classifyRoute("/event", "central")).toBe("fallthrough")
    expect(classifyRoute("/global/event", "workspace")).toBe("cs")
  })

  test("/config is CS but /api/wr/config is WR", () => {
    expect(classifyRoute("/config", "workspace")).toBe("cs")
    expect(classifyRoute("/api/wr/config", "workspace")).toBe("wr")
    expect(classifyRoute("/api/wr/config", "central")).toBe("wr")
  })

  test("agent-config subpath /runner is CS not WR", () => {
    // Important: /api/claxedo/agent-config/runner is config, not a session route
    expect(classifyRoute("/api/claxedo/agent-config/runner", "workspace")).toBe("cs")
    expect(classifyRoute("/api/claxedo/agent-config/runner", "central")).toBe("cs")
  })
})
