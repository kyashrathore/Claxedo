import { describe, expect, test } from "bun:test"
import path from "node:path"
import { generateKeyPair } from "jose"
import type {
  WorkspaceRelayAuthOptions,
  WorkspaceRelayDrainOptions,
  WorkspaceRelayMetricsOptions,
  WorkspaceRelayRoutingOptions,
  WorkspaceRelayTelemetryOptions,
} from "./server"
import {
  createWorkspaceRelayBun,
  type HostTunnelAuthorizationResult,
  type WorkspaceRelayBackpressureOptions,
  type WorkspaceRelayHostTunnelOptions,
} from "./bun"
import { createWorkspaceRelayDirectory } from "./directory"
import { hostTunnelTokenAudience, runtimeAccessTokenIssuer } from "./auth"

type StableServerOptionGroups = [
  WorkspaceRelayAuthOptions,
  WorkspaceRelayRoutingOptions,
  WorkspaceRelayTelemetryOptions,
  WorkspaceRelayDrainOptions,
  WorkspaceRelayMetricsOptions,
]

type StableBunOptionGroups = [
  WorkspaceRelayHostTunnelOptions,
  WorkspaceRelayBackpressureOptions,
]

const forbiddenPackages = [
  "claxedo-server",
  "control-plane",
  "workspace-store",
  "credentials",
]

function isForbiddenSpecifier(input: string) {
  return forbiddenPackages.some((name) => input.includes(name))
}

describe("workspace relay composition boundary", () => {
  test("package manifest does not depend on control-plane or store implementations", async () => {
    const manifest = await Bun.file(path.join(import.meta.dirname, "..", "package.json")).json() as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    const dependencyNames = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ]

    expect(dependencyNames.filter(isForbiddenSpecifier)).toEqual([])
  })

  test("relay dependency graph does not import control-plane or store implementations", async () => {
    const files = [
      "auth.ts",
      "bun.ts",
      "cloudflare.ts",
      "directory.ts",
      "main.ts",
      "server.ts",
    ].map((file) => path.join(import.meta.dirname, file))
    const transpiler = new Bun.Transpiler({ loader: "ts" })

    for (const file of files) {
      const imports = transpiler.scanImports(await Bun.file(file).text())
      expect(imports.map((entry) => entry.path).filter(isForbiddenSpecifier)).toEqual([])
    }
  })

  test("stable option groups are importable for auth, routing, telemetry, drain, host tunnels, and backpressure", () => {
    const serverOptionGroupCount: StableServerOptionGroups["length"] = 5
    const bunOptionGroupCount: StableBunOptionGroups["length"] = 2

    expect(serverOptionGroupCount).toBe(5)
    expect(bunOptionGroupCount).toBe(2)
  })
})

describe("host-tunnel authorization seam", () => {
  function hostTunnelClaims(input: { hostId: string; workspaceIds: string[] }): Record<string, unknown> {
    return {
      iss: runtimeAccessTokenIssuer,
      aud: hostTunnelTokenAudience,
      sub: "host-client-test",
      host_id: input.hostId,
      workspace_ids: input.workspaceIds,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      jti: crypto.randomUUID(),
    }
  }

  async function startRelay(authorizeHostTunnel: NonNullable<WorkspaceRelayHostTunnelOptions["authorizeHostTunnel"]>) {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const directory = createWorkspaceRelayDirectory()
    const handler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory,
      resolveTarget: async () => undefined,
    }, { authorizeHostTunnel })
    const relay = Bun.serve({ port: 0, fetch: handler.fetch, websocket: handler.websocket })
    return { relay, directory }
  }

  function requestUpgrade(relay: { url: URL }, path: string) {
    return fetch(new URL(path, relay.url), { headers: { upgrade: "websocket" } })
  }

  test("a permissive policy cannot register a host its claims do not bind", async () => {
    // The policy grants everything, but only ever produces claims for host_2.
    const permissive = (): HostTunnelAuthorizationResult => ({
      authorized: true,
      claims: hostTunnelClaims({ hostId: "host_2", workspaceIds: ["ws_1", "ws_2"] }),
    })
    const { relay, directory } = await startRelay(permissive)

    try {
      const hostMismatch = await requestUpgrade(relay, "/host-tunnels/host_1?workspaceId=ws_1")
      expect(hostMismatch.status).toBe(403)

      const workspaceMismatch = await requestUpgrade(relay, "/host-tunnels/host_2?workspaceId=ws_3")
      expect(workspaceMismatch.status).toBe(403)

      expect(directory.activeHost({ hostId: "host_1", workspaceId: "ws_1" })).toBeUndefined()
      expect(directory.activeHost({ hostId: "host_2", workspaceId: "ws_3" })).toBeUndefined()
    } finally {
      await relay.stop(true)
    }
  })

  test("a permissive policy admitting its own claims still upgrades the tunnel", async () => {
    const permissive: NonNullable<WorkspaceRelayHostTunnelOptions["authorizeHostTunnel"]> = (_request, input) => ({
      authorized: true,
      claims: hostTunnelClaims(input),
    })
    const { relay, directory } = await startRelay(permissive)
    const ws = new WebSocket(
      new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
    )

    try {
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve()
        ws.onerror = () => reject(new Error("WebSocket failed to open"))
      })
      expect(directory.activeHost({ hostId: "host_1", workspaceId: "ws_1" })).toMatchObject({
        hostId: "host_1",
        workspaceIds: ["ws_1"],
      })
    } finally {
      ws.close()
      await relay.stop(true)
    }
  })
})
