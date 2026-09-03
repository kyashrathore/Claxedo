import { describe, expect, test } from "vitest"

import { userHostedSurface } from "./user-hosted-surface"

const WORKSPACE_ID = "5f39af3e-75c4-4392-baaf-574acbbf9db9"
const OTHER_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222"
const LOCAL_BASE_URL = "http://127.0.0.1:2593"

function surface(path: string) {
  return userHostedSurface({ localBaseUrl: LOCAL_BASE_URL, workspaceId: WORKSPACE_ID, path })
}

describe("deny — the daemon's own families never cross the tunnel", () => {
  test.each([
    // The exact 403 verified live: relayed host-serving administration.
    "/api/claxedo/host-serving",
    "/api/claxedo/health",
    "/api/claxedo/remote-access/enable",
    "/api/control",
    "/api/control/foo",
    "/api/workspace",
    "/api/workspace/resolve",
    "/api/auth/device/code",
    "/api/runtime-authority/revoke",
    // Daemon-wide, not this workspace's to trigger — even though it IS part
    // of the OpenCode-compat family root serves for a loopback caller.
    "/global/dispose",
    // Nested workspace-relay paths: a relayed path never legitimately
    // re-enters this family, since the relay already stripped the
    // `/workspaces/:id` prefix before handing the path to this tunnel.
    "/workspaces",
    `/workspaces/${OTHER_WORKSPACE_ID}/session`,
    "/host-tunnels/host_1",
    "/health",
    "/.well-known/jwks.json",
    "/internal/relay/foo",
  ])("%s", (path) => {
    expect(surface(path)).toEqual({ kind: "deny" })
  })

  test("does not deny the daemon's liveness probe by matching a query-bearing sibling", () => {
    // Regression guard for a naive substring match: `/health` must not deny
    // `/healthcheck` (no such route exists, but the matcher must not treat a
    // shared prefix as a family boundary).
    expect(surface("/healthcheck")).not.toEqual({ kind: "deny" })
  })
})

describe("root — the OpenCode-compat family the daemon root serves for a workspace", () => {
  test("maps /provider/auth to root with the workspace forced into ?directory=", () => {
    const target = surface("/provider/auth")
    expect(target.kind).toBe("root")
    if (target.kind !== "root") throw new Error("unreachable")
    expect(target.url.origin + target.url.pathname).toBe(`${LOCAL_BASE_URL}/provider/auth`)
    expect(target.url.searchParams.get("directory")).toBe(WORKSPACE_ID)
  })

  test("maps /config, /project, and /project/current to root", () => {
    for (const path of ["/config", "/project", "/project/current"]) {
      const target = surface(path)
      expect(target.kind, path).toBe("root")
      if (target.kind !== "root") throw new Error("unreachable")
      expect(target.url.pathname, path).toBe(path)
      expect(target.url.searchParams.get("directory"), path).toBe(WORKSPACE_ID)
    }
  })

  test("maps /auth/:providerID to root, but not a bare /auth", () => {
    const target = surface("/auth/anthropic")
    expect(target.kind).toBe("root")
    if (target.kind !== "root") throw new Error("unreachable")
    expect(target.url.pathname).toBe("/auth/anthropic")

    expect(surface("/auth").kind).toBe("workspace")
    expect(surface("/auth/").kind).toBe("workspace")
  })

  test("maps /provider/:providerID/oauth/:step to root, but not /provider or /provider/:id alone", () => {
    const target = surface("/provider/anthropic/oauth/authorize")
    expect(target.kind).toBe("root")
    if (target.kind !== "root") throw new Error("unreachable")
    expect(target.url.pathname).toBe("/provider/anthropic/oauth/authorize")

    // The runtime serves the catalog itself (host-injected for non-opencode
    // harnesses) — these stay on the workspace surface.
    expect(surface("/provider").kind).toBe("workspace")
    expect(surface("/provider?harness=opencode").kind).toBe("workspace")
    expect(surface("/provider/anthropic").kind).toBe("workspace")
  })

  test("preserves the request's own query alongside the forced directory", () => {
    const target = surface("/config?harness=opencode")
    expect(target.kind).toBe("root")
    if (target.kind !== "root") throw new Error("unreachable")
    expect(target.url.searchParams.get("harness")).toBe("opencode")
    expect(target.url.searchParams.get("directory")).toBe(WORKSPACE_ID)
  })

  /**
   * A relayed caller holds a connection scoped to exactly one workspace. If
   * this forwarded a caller-supplied `directory` unchanged, that caller could
   * name a DIFFERENT workspace in its own query string and read that
   * workspace's `/project/current`, or connect ITS provider credentials,
   * through THIS connection's root surface — the path-confusion privilege
   * escalation the tunnel's per-workspace scoping exists to prevent.
   */
  test("overrides a caller-supplied directory rather than trusting it", () => {
    const target = surface(`/project/current?directory=${OTHER_WORKSPACE_ID}`)
    expect(target.kind).toBe("root")
    if (target.kind !== "root") throw new Error("unreachable")
    expect(target.url.searchParams.get("directory")).toBe(WORKSPACE_ID)
    expect(target.url.searchParams.getAll("directory")).toHaveLength(1)
  })

  test("sends the bare workspace id, not a workspace:<id>-prefixed form", () => {
    // `resolveWorkspace({directory})` (server-core/workspace/store) does not
    // parse a `workspace:` prefix — that convention belongs to a different
    // router (session/routes/meta-routes.ts) — so a prefixed value would
    // resolve nothing on the compat root's `/project/current`.
    const target = surface("/project/current")
    if (target.kind !== "root") throw new Error("unreachable")
    expect(target.url.searchParams.get("directory")).not.toContain("workspace:")
  })
})

describe("workspace — everything else maps to the workspace surface", () => {
  test.each([
    "/path",
    "/api/wr/capabilities",
    "/api/wr/worktrees",
    "/api/wr/checkpoint/list",
    "/api/wr/subagent-transcripts",
    "/api/wr/file",
    "/api/wr/find/text",
    "/session",
    "/provider?harness=opencode",
    // The runtime's own identity probe, admitted directly rather than
    // through the root-surface table, which classifies this path central for
    // the daemon's OWN liveness probe.
    "/global/health",
    // Not on any allow-list — the runtime answers an honest 404 for a path it
    // does not implement, rather than this module refusing it with a 403.
    "/some/path/the/runtime/does/not/implement",
  ])("%s", (path) => {
    const target = surface(path)
    expect(target.kind, path).toBe("workspace")
    if (target.kind !== "workspace") throw new Error("unreachable")
    expect(target.url.pathname.startsWith(`/workspaces/${WORKSPACE_ID}/`), path).toBe(true)
  })

  test("prefixes the path onto the workspace surface and keeps its query", () => {
    const target = surface("/api/wr/health?probe=1")
    if (target.kind !== "workspace") throw new Error("unreachable")
    expect(target.url.pathname).toBe(`/workspaces/${WORKSPACE_ID}/api/wr/health`)
    expect(target.url.searchParams.get("probe")).toBe("1")
  })
})
