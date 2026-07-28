/**
 * Tests the route ownership contract used by the workspace-runtime proxy.
 *
 * Each path has two pieces of information:
 * - product domain: who should own the API long-term
 * - current handler: where the request is handled today
 *
 * Some config-shaped APIs still route through workspace-runtime today. Those
 * entries are intentionally visible in this map so Phase 2 can move them into
 * Agent Config Registry without rediscovering the proxy contract.
 */

import { describe, expect, test } from "vitest"
import { runtimeProxyResponseHeaders } from "./proxy"
import { routeOwnership, routeRules, RouteDomain, RouteHandler } from "./route-ownership"

function classify(path: string) {
  return routeOwnership(path.split("?")[0])
}

describe("route ownership", () => {
  test("runtime proxy strips stale decompression headers", () => {
    const headers = runtimeProxyResponseHeaders(
      new Headers({
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": "42",
      }),
    )

    expect(headers.get("content-type")).toBe("application/json")
    expect(headers.get("content-encoding")).toBeNull()
    expect(headers.get("content-length")).toBeNull()
  })

  test("Claxedo Control Plane routes are handled centrally", () => {
    const paths = [
      "/.well-known/jwks.json",
      "/global/health",
      "/path",
      "/api/claxedo/health",
      "/api/claxedo/track",
      "/api/claxedo/bootstrap",
      "/project",
      "/project/current",
      "/experimental",
      "/api/claxedo/session",
      "/api/claxedo/session/meta",
      "/api/control",
      "/api/control/runtime/heartbeat",
      "/api/workspace",
      "/api/workspace/drivers",
      "/api/claxedo/network-policy",
      "/documents",
      "/documents/some-document",
      "/documents",
      "/documents/document_1/content",
      "/api/workgraph",
      "/api/workgraph/runs",
    ]

    for (const path of paths) {
      expect(classify(path)).toMatchObject({
        domain: RouteDomain.ClaxedoControlPlane,
        handler: RouteHandler.CentralServer,
      })
    }
  })

  test("Channels routes are handled centrally", () => {
    for (const path of ["/api/channels", "/api/channels/fake", "/api/channels/github/webhook"]) {
      expect(classify(path)).toMatchObject({
        domain: RouteDomain.Channels,
        handler: RouteHandler.CentralServer,
      })
    }
  })

  test("Workspace Relay coordination routes are handled centrally", () => {
    const paths = ["/internal/relay/target", "/internal/relay/revocation"]

    for (const path of paths) {
      expect(classify(path)).toMatchObject({
        domain: RouteDomain.WorkspaceRelay,
        handler: RouteHandler.CentralServer,
      })
    }
  })

  test("Agent Config Registry routes are centrally owned when current code already handles them centrally", () => {
    const paths = [
      "/config",
      "/global/config",
      "/provider",
      "/provider/auth",
      "/provider/claude-acp/oauth/start",
      "/auth/openai",
      "/api/claxedo/agent-config",
      "/api/claxedo/agent-config/harness",
      "/api/claxedo/agent-config/mcp/my-server",
      "/api/claxedo/agent-config/commands",
      "/api/claxedo/agent-config/harness/options",
      "/api/claxedo/credentials",
      "/api/claxedo/credentials/openai",
    ]

    for (const path of paths) {
      expect(classify(path)).toMatchObject({
        domain: RouteDomain.AgentConfigRegistry,
        handler: RouteHandler.CentralServer,
      })
    }
  })

  test("Agent Config Registry runtime-routed surfaces are explicit", () => {
    const paths = [
      "/api/wr/config",
      "/api/wr/harness-config-options",
      "/mcp",
      "/mcp/local/connect",
      "/mcp/local/disconnect",
      "/agent",
      "/command",
    ]

    for (const path of paths) {
      const ownership = classify(path)
      expect(ownership.handler).toBe(RouteHandler.SandboxRuntime)
      if (ownership.handler !== RouteHandler.SandboxRuntime) throw new Error(`Unexpected handler for ${path}`)
      expect(ownership.domain).toBe(RouteDomain.AgentConfigRegistry)
      expect(ownership.phase).toBeTruthy()
    }
  })

  test("Agent Session Runtime routes are handled by workspace runtime", () => {
    const paths = [
      "/session",
      "/session/abc123",
      "/session/abc123/message",
      "/session/abc123/prompt_async",
      "/permission",
      "/permission/abc123",
      "/question",
      "/question/abc123",
      "/event",
      "/experimental/session",
    ]

    for (const path of paths) {
      expect(classify(path)).toMatchObject({
        domain: RouteDomain.AgentSessionRuntime,
        handler: RouteHandler.SandboxRuntime,
      })
    }
  })

  test("Sandbox Runtime routes are handled by workspace runtime", () => {
    const paths = [
      "/api/wr/health",
      "/api/wr/capabilities",
      "/file",
      "/file/all",
      "/file/content",
      "/file/status",
      "/find",
      "/find/file",
      "/api/wr/pty",
      "/api/wr/pty/abc123/connect",
      "/api/wr/process",
      "/api/wr/process?workspaceId=ws_123",
      "/api/wr/diff",
      "/api/wr/diff/targets",
      "/api/wr/events",
      "/api/wr/runtime-events",
      "/api/wr/hook",
      "/api/wr/hook/agent-lifecycle",
      "/global/event",
      "/lsp",
      "/vcs",
    ]

    for (const path of paths) {
      expect(classify(path)).toMatchObject({
        domain: RouteDomain.SandboxRuntime,
        handler: RouteHandler.SandboxRuntime,
      })
    }
  })

  test("Agent hook routes are Sandbox Runtime domain and handled by workspace runtime", () => {
    expect(classify("/api/wr/hook")).toMatchObject({
      domain: RouteDomain.SandboxRuntime,
      handler: RouteHandler.SandboxRuntime,
    })
    expect(classify("/api/wr/hook/agent-lifecycle")).toMatchObject({
      domain: RouteDomain.SandboxRuntime,
      handler: RouteHandler.SandboxRuntime,
    })
  })

  test("unknown paths are unclaimed", () => {
    for (const path of ["/unknown", "/api/something-else", "/random/endpoint"]) {
      expect(classify(path)).toMatchObject({
        handler: RouteHandler.Unclaimed,
      })
    }
  })

  test("route rules do not contain duplicate exact path claims", () => {
    const exact = routeRules()
      .filter((rule) => rule.match === "exact")
      .flatMap((rule) => rule.paths)
    expect(exact.filter((path, index) => exact.indexOf(path) !== index)).toEqual([])
  })

  test("route rules keep central prefixes disjoint from runtime prefixes", () => {
    const prefixes = routeRules().filter((rule) => rule.match === "prefix")
    const central = prefixes.filter((rule) => rule.handler === RouteHandler.CentralServer).flatMap((rule) => rule.paths)
    const runtime = prefixes
      .filter((rule) => rule.handler === RouteHandler.SandboxRuntime)
      .flatMap((rule) => rule.paths)

    for (const c of central) {
      for (const r of runtime) {
        expect(c).not.toBe(r)
        expect(c.startsWith(r + "/")).toBe(false)
        expect(r.startsWith(c + "/")).toBe(false)
      }
    }
  })
})
