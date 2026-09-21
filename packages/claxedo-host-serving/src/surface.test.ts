import { describe, expect, test } from "vitest"

import { hostServingSurface } from "./surface"

const WORKSPACE_ID = "5f39af3e-75c4-4392-baaf-574acbbf9db9"
const OTHER_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222"
const LOCAL_BASE_URL = "http://127.0.0.1:2593"

function surface(path: string) {
  return hostServingSurface({ localBaseUrl: LOCAL_BASE_URL, workspaceId: WORKSPACE_ID, path })
}

describe("deny — the daemon's own families never cross the tunnel", () => {
  test.each([
    "/api/claxedo/host-serving",
    "/api/claxedo/health",
    "/api/cp/events",
    "/api/claxedo/remote-access/enable",
    "/api/control",
    "/api/control/foo",
    "/api/workspace",
    "/api/workspace/resolve",
    "/api/auth/device/code",
    "/api/runtime-authority/revoke",
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

  test("does not deny a path that merely shares `/health` as a prefix", () => {
    // A shared prefix is not a family boundary; `/healthcheck` names no route,
    // which is what makes it the probe for a substring match.
    expect(surface("/healthcheck")).not.toEqual({ kind: "deny" })
  })
})

describe("deny — the machine's credential and inventory families", () => {
  test.each([
    // Connecting a provider account, and the OAuth exchange that replaces
    // whatever this machine already held for that provider.
    "/provider/auth",
    "/provider/anthropic/oauth/authorize",
    "/provider/anthropic/oauth/callback",
    "/provider",
    "/provider?harness=opencode",
    "/provider/anthropic",
    "/auth",
    "/auth/anthropic",
    "/config",
    "/config?harness=opencode",
    // Every project this machine holds, and the metadata write on one of them.
    "/project",
    "/project/current",
    `/project/current?directory=${OTHER_WORKSPACE_ID}`,
    "/project/prj_1",
  ])("%s", (path) => {
    expect(surface(path)).toEqual({ kind: "deny" })
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
    "/session-start/start_1?directory=%2Frepo",
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

  test("runs against this connection's workspace, whatever the caller selected", () => {
    const target = surface(`/session?directory=${OTHER_WORKSPACE_ID}`)
    if (target.kind !== "workspace") throw new Error("unreachable")
    expect(target.url.pathname).toBe(`/workspaces/${WORKSPACE_ID}/session`)
  })

  test.each([
    "/../../session?directory=other",
    "/%2e%2e/%2e%2e/session?directory=other",
    "/a/../../../session?directory=other",
    "/..\\..\\session?directory=other",
  ])("normalizes %s before binding the authorized workspace", (path) => {
    const target = surface(path)
    if (target.kind !== "workspace") throw new Error("unreachable")
    expect(target.url.pathname).toBe(`/workspaces/${WORKSPACE_ID}/session`)
    expect(target.url.searchParams.get("directory")).toBe("other")
  })
})
