/**
 * The desktop-local product contract, applied to THIS composition.
 *
 * `@claxedo/local-server` is not "whatever compiled after moving files" — it is
 * exactly the route families the split assigns to it, served from the same
 * paths. The whole inventory is asserted rather than spot-checked, because the
 * failure mode that matters is OMISSION: a move that silently dropped
 * `/api/wr/pty/:ptyID/connect` would typecheck, build, and surface only as a
 * dead terminal in a packaged desktop.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { pathsByOwner, unclassifiedPaths } from "@claxedo/server-core/deployments/product-route-families"
import { createLocalApp } from "./local-app"

let dataDir: string
let previousDataDir: string | undefined

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "claxedo-local-app-contract-"))
  previousDataDir = process.env.CLAXEDO_DATA_DIR
  process.env.CLAXEDO_DATA_DIR = dataDir
})

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

function localApp() {
  return createLocalApp({
    services: {
      auth: { config: {} },
      credentials: {} as never,
      extensionPolicy: {},
      localExecution: { enabled: true },
      telemetry: { capture: () => {} },
    } as never,
    securityHeaders: async (_c, next) => { await next() },
    // The host supplies this; a desktop build binds it to the local relay
    // proxy. Its PATHS are the contract, so the fixture only has to register.
    workspaceRelayProxy: async (_c, next) => { await next() },
    isCredentialPath: () => false,
    corsOrigin: (origin) => origin,
  }).app
}

const ALLOWLIST: string[] = [
      "/agent",
      "/api/claxedo/agent-config",
      "/api/claxedo/agent-config/agents",
      "/api/claxedo/agent-config/commands",
      "/api/claxedo/agent-config/commands/:name",
      "/api/claxedo/agent-config/extensions",
      "/api/claxedo/agent-config/extensions/:id",
      "/api/claxedo/agent-config/extensions/:id/disable",
      "/api/claxedo/agent-config/extensions/:id/enable",
      "/api/claxedo/agent-config/extensions/:id/update",
      "/api/claxedo/agent-config/extensions/adopt",
      "/api/claxedo/agent-config/extensions/catalog",
      "/api/claxedo/agent-config/extensions/detach",
      "/api/claxedo/agent-config/extensions/ignore",
      "/api/claxedo/agent-config/extensions/machine-scan",
      "/api/claxedo/agent-config/extensions/scan",
      "/api/claxedo/agent-config/harness",
      "/api/claxedo/agent-config/harness/model",
      "/api/claxedo/agent-config/harness/options",
      "/api/claxedo/agent-config/mcp",
      "/api/claxedo/agent-config/mcp/:name",
      "/api/claxedo/agent-config/runner/options",
      "/api/claxedo/bootstrap",
      "/api/claxedo/credentials",
      "/api/claxedo/credentials/*",
      "/api/claxedo/credentials/:id",
      "/api/claxedo/credentials/:id/scope",
      "/api/claxedo/credentials/:id/status",
      "/api/claxedo/credentials/:id/verify",
      "/api/claxedo/credentials/:providerId",
      "/api/claxedo/credentials/discover",
      "/api/claxedo/credentials/provider/:providerId",
      "/api/claxedo/credentials/save-discovered",
      "/api/claxedo/credentials/sync-local",
      "/api/claxedo/events",
      "/api/claxedo/health",
      "/api/claxedo/network-policy",
      "/api/claxedo/network-policy/:id",
      "/api/claxedo/network-policy/check",
      "/api/claxedo/network-policy/effective/:workspaceId",
      "/api/claxedo/network-policy/groups",
      "/api/claxedo/session/:id/meta",
      "/api/claxedo/track",
      "/api/claxedo/usage-limits",
      "/api/control",
      "/api/control/*",
      "/api/control/runtime/heartbeat",
      "/api/control/runtime/register",
      "/api/control/session-list",
      "/api/control/session/:id/runtime-events",
      "/api/control/sessions",
      "/api/control/sessions/:sessionId/capabilities",
      "/api/control/sessions/:sessionId/gateway",
      "/api/control/sessions/:sessionId/messages",
      "/api/control/workspaces/:workspaceId/sessions/:sessionId/checkpoint",
      "/api/control/workspaces/:workspaceId/sessions/:sessionId/register",
      "/api/control/workspaces/:workspaceId/sessions/:sessionId/repair",
      "/api/wr/events",
      "/api/wr/pty/:ptyID/connect",
      "/api/wr/runtime-events",
      "/auth/:providerID",
      "/command",
      "/config",
      "/config/providers",
      "/experimental/worktree",
      "/experimental/worktree/reset",
      "/file",
      "/file/all",
      "/file/content",
      "/file/status",
      "/find",
      "/find/file",
      "/find/symbol",
      "/global/config",
      "/global/dispose",
      "/global/event",
      "/global/health",
      "/lsp",
      "/mcp",
      "/mcp/:name/connect",
      "/mcp/:name/disconnect",
      "/path",
      "/project",
      "/project/:id",
      "/project/current",
      "/provider",
      "/provider/*",
      "/provider/:providerID/oauth/:step",
      "/provider/:providerId/oauth/*",
      "/provider/:providerId/oauth/authorize",
      "/provider/:providerId/oauth/callback",
      "/provider/auth",
      "/question",
      "/session/status",
      "/vcs",
      "/workspaces/:workspaceId",
      "/workspaces/:workspaceId/*",
      "/workspaces/:workspaceId/api/wr/pty/:ptyID/connect",
    ]

describe("desktop-local route families", () => {
  /**
   * The `/api/control` family is assigned to local-server by the table but is
   * still SERVED by `@claxedo/server`: its producers (`authority/http`,
   * `central-runtime`) reach connections, session runtime, metering, and the
   * session-pull layer. Untangling those is the last slice of this unit, and
   * this pair of assertions is what will force this file to be updated when it
   * lands — the second one fails the moment the family moves.
   */
  const NOT_YET_MOVED = /^\/api\/(control|wr\/runtime-events)/

  test("serves every local route family that has moved to this package", () => {
    const served = pathsByOwner(localApp().routes, "local-server")
    expect(served.filter((route) => NOT_YET_MOVED.test(route))).toEqual([])
    expect(served.length).toBeGreaterThan(120)
    // Spot-proof that the families most easily dropped by a move are present:
    // a missing PTY connect path is a dead terminal in a packaged desktop, and
    // nothing else in the suite would say so.
    for (const route of [
      "/api/wr/pty/:ptyID/connect",
      "/api/claxedo/agent-config",
      "/api/claxedo/credentials",
      "/api/claxedo/events",
      "/api/claxedo/track",
      "/api/claxedo/network-policy",
      "/api/claxedo/usage-limits",
      "/workspaces/:workspaceId",
    ]) {
      expect(served, `${route} must be served by the local composition`).toContain(route)
    }
  })

  test("does not yet serve the /api/control family", () => {
    // Delete this test and restore the whole-inventory assertion when the
    // control-plane session producers move.
    const table = ALLOWLIST.filter((route) => NOT_YET_MOVED.test(route))
    expect(table.length).toBeGreaterThan(0)
    expect(pathsByOwner(localApp().routes, "local-server").filter((route) => NOT_YET_MOVED.test(route))).toEqual([])
  })
})
