import { describe, expect, test } from "bun:test"
import path from "node:path"
import type {
  WorkspaceRelayAuthOptions,
  WorkspaceRelayDrainOptions,
  WorkspaceRelayMetricsOptions,
  WorkspaceRelayRoutingOptions,
  WorkspaceRelayTelemetryOptions,
} from "./server"
import type {
  WorkspaceRelayBackpressureOptions,
  WorkspaceRelayHostTunnelOptions,
} from "./bun"

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
