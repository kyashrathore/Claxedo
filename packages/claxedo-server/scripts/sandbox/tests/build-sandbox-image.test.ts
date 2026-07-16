import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { DEFAULT_WORKSPACE_RUNTIME_PORT } from "@claxedo/sandbox-manager"
import {
  esbuildHostBundleOptions,
  HOST_BUNDLE_FILENAME,
  OPENCODE_BINARY_FILENAME,
  hostBundleDependencies,
  sandboxImageBuildArgs,
  validateBuildFlags,
  workspacePackageBuildOrder,
} from "../build-sandbox-image"

describe("build-sandbox-image", () => {
  test("builds from the sandbox scripts context with no version build-arg", () => {
    expect(sandboxImageBuildArgs({
      tags: ["ghcr.io/example/claxedo-sandbox:workspace-runtime-0-5-1-v8"],
      push: true,
      dockerfile: "/tmp/Dockerfile",
      context: "/tmp/context",
    })).toEqual([
      "buildx",
      "build",
      "--platform",
      "linux/amd64",
      "-t",
      "ghcr.io/example/claxedo-sandbox:workspace-runtime-0-5-1-v8",
      "--push",
      "-f",
      "/tmp/Dockerfile",
      "/tmp/context",
    ])
  })

  test("defaults the build context to the sandbox scripts directory", () => {
    const args = sandboxImageBuildArgs({ tags: ["t"], push: false })
    expect(args.at(-1)).toBe(path.resolve(import.meta.dirname, ".."))
    expect(args).toContain("--load")
  })

  test("esbuild options bundle only @claxedo workspace code", () => {
    const options = esbuildHostBundleOptions({ entry: "/repo/host-entry.ts", outfile: `/out/${HOST_BUNDLE_FILENAME}` })
    expect(options.entryPoints).toEqual(["/repo/host-entry.ts"])
    expect(options.bundle).toBe(true)
    expect(options.platform).toBe("node")
    expect(options.outfile).toBe(`/out/${HOST_BUNDLE_FILENAME}`)
    // The workspace-only plugin externalizes every non-@claxedo import.
    const plugin = options.plugins[0]!
    expect(plugin.name).toBe("claxedo-workspace-only")
    let resolver: ((args: { path: string }) => { path: string; external: boolean } | undefined) | undefined
    plugin.setup({ onResolve: (_opts, cb) => { resolver = cb } })
    expect(resolver!({ path: "better-sqlite3" })).toEqual({ path: "better-sqlite3", external: true })
    expect(resolver!({ path: "@cursor/sdk" })).toEqual({ path: "@cursor/sdk", external: true })
    expect(resolver!({ path: "@claxedo/workspace-runtime" })).toBeUndefined()
  })

  test("image dependency pins merge workspace package.jsons, workspace-runtime wins conflicts", () => {
    const packages: Record<string, { name: string; dependencies: Record<string, string> }> = {
      "workspace-runtime": {
        name: "@claxedo/workspace-runtime",
        dependencies: {
          "better-sqlite3": "12.10.0",
          "node-pty": "1.1.0",
          "@zed-industries/claude-agent-acp": "0.22.1",
          "@agentclientprotocol/codex-acp": "0.10.0",
          "@claxedo/agent-sdk-runtime": "0.5.1",
          hono: "4.12.12",
        },
      },
      "agent-sdk-runtime": {
        name: "@claxedo/agent-sdk-runtime",
        dependencies: { hono: "4.10.7", "just-bash": "3.0.1" },
      },
    }
    const deps = hostBundleDependencies((dir) => {
      const key = Object.keys(packages).find((name) => dir.endsWith(name))
      if (!key) throw new Error(`unexpected package dir: ${dir}`)
      return packages[key]!
    })
    expect(deps).toEqual({
      "better-sqlite3": "12.10.0",
      "node-pty": "1.1.0",
      "@zed-industries/claude-agent-acp": "0.22.1",
      "@agentclientprotocol/codex-acp": "0.10.0",
      hono: "4.12.12",
      "just-bash": "3.0.1",
    })
  })

  test("missing image dependency pins fail loudly", () => {
    expect(() => hostBundleDependencies(() => ({ dependencies: { "better-sqlite3": "12.10.0" } })))
      .toThrow("missing image dependency")
  })

  test("real workspace-runtime package.json satisfies the image dependency pins", () => {
    const deps = hostBundleDependencies()
    expect(Object.keys(deps)).toEqual(expect.arrayContaining([
      "better-sqlite3",
      "node-pty",
      "@zed-industries/claude-agent-acp",
      "@agentclientprotocol/codex-acp",
    ]))
    expect(deps.zod).toBe("4.1.8")
  })

  test("production image starts the flattened workspace-runtime dependency graph", () => {
    const dockerfiles = ["../Dockerfile", "../cloudflare-worker/Dockerfile"]
      .map((file) => fs.readFileSync(path.resolve(import.meta.dirname, file), "utf8"))
    expect(dockerfiles.every((dockerfile) => dockerfile.includes("timeout 5s workspace-runtime"))).toBe(true)
    expect(dockerfiles.every((dockerfile) => dockerfile.includes('[ "$status" -ne 124 ]'))).toBe(true)
  })

  test("production images install and smoke the checkout's Session V2 OpenCode binary", () => {
    const dockerfiles = ["../Dockerfile", "../cloudflare-worker/Dockerfile"]
      .map((file) => fs.readFileSync(path.resolve(import.meta.dirname, file), "utf8"))
    for (const dockerfile of dockerfiles) {
      expect(dockerfile).toContain(`test -x /opt/workspace-runtime/${OPENCODE_BINARY_FILENAME}`)
      expect(dockerfile).toContain(`install -m 0755 /opt/workspace-runtime/${OPENCODE_BINARY_FILENAME} /usr/local/bin/opencode`)
      expect(dockerfile).toContain("http://127.0.0.1:4096/api/session")
      expect(dockerfile).toContain("Session V2 create did not adopt the requested id")
    }
  })

  test("Cloudflare data-plane proxy targets the canonical workspace-runtime port", () => {
    const worker = fs.readFileSync(
      path.resolve(import.meta.dirname, "../cloudflare-worker/src/index.ts"),
      "utf8",
    )
    expect(worker).toContain(`const WORKSPACE_RUNTIME_PORT = ${DEFAULT_WORKSPACE_RUNTIME_PORT}`)
  })

  test("workspace package build order is topological (dependencies before dependents, workspace-runtime last)", () => {
    // Fake graph:
    //   workspace-runtime -> agent-sdk-runtime, workspace-relay
    //   agent-sdk-runtime -> agent-event-runtime
    //   workspace-relay   -> workspace-relay-protocol
    const packages: Record<string, { name: string; dependencies: Record<string, string> }> = {
      "workspace-runtime": {
        name: "@claxedo/workspace-runtime",
        dependencies: {
          "@claxedo/agent-sdk-runtime": "0.5.1",
          "@claxedo/workspace-relay": "0.5.1",
          "better-sqlite3": "12.10.0",
        },
      },
      "agent-sdk-runtime": {
        name: "@claxedo/agent-sdk-runtime",
        dependencies: { "@claxedo/agent-event-runtime": "0.5.1" },
      },
      "agent-event-runtime": { name: "@claxedo/agent-event-runtime", dependencies: {} },
      "workspace-relay": {
        name: "@claxedo/workspace-relay",
        dependencies: { "@claxedo/workspace-relay-protocol": "0.5.1" },
      },
      "workspace-relay-protocol": { name: "@claxedo/workspace-relay-protocol", dependencies: {} },
    }
    const dirKey = (dir: string) => {
      const key = Object.keys(packages).find((name) => dir.endsWith(name))
      if (!key) throw new Error(`unexpected package dir: ${dir}`)
      return key
    }
    const order = workspacePackageBuildOrder((dir) => packages[dirKey(dir)]!)
    const names = order.map((dir) => packages[dirKey(dir)]!.name)

    // Every dependency comes before its dependent.
    const before = (a: string, b: string) => names.indexOf(a) < names.indexOf(b)
    expect(before("@claxedo/agent-event-runtime", "@claxedo/agent-sdk-runtime")).toBe(true)
    expect(before("@claxedo/agent-sdk-runtime", "@claxedo/workspace-runtime")).toBe(true)
    expect(before("@claxedo/workspace-relay-protocol", "@claxedo/workspace-relay")).toBe(true)
    expect(before("@claxedo/workspace-relay", "@claxedo/workspace-runtime")).toBe(true)
    // workspace-runtime is always last; no duplicates.
    expect(names.at(-1)).toBe("@claxedo/workspace-runtime")
    expect(new Set(names).size).toBe(names.length)
  })

  test("workspace package build order visits a shared dependency once", () => {
    // Diamond: both agent-sdk-runtime and workspace-relay depend on shared.
    const packages: Record<string, { name: string; dependencies: Record<string, string> }> = {
      "workspace-runtime": {
        name: "@claxedo/workspace-runtime",
        dependencies: { "@claxedo/agent-sdk-runtime": "0.5.1", "@claxedo/workspace-relay": "0.5.1" },
      },
      "agent-sdk-runtime": { name: "@claxedo/agent-sdk-runtime", dependencies: { "@claxedo/shared": "0.5.1" } },
      "workspace-relay": { name: "@claxedo/workspace-relay", dependencies: { "@claxedo/shared": "0.5.1" } },
      shared: { name: "@claxedo/shared", dependencies: {} },
    }
    const order = workspacePackageBuildOrder((dir) => {
      const key = Object.keys(packages).find((name) => dir.endsWith(name))
      if (!key) throw new Error(`unexpected package dir: ${dir}`)
      return packages[key]!
    })
    const names = order.map((dir) => {
      const key = Object.keys(packages).find((name) => dir.endsWith(name))!
      return packages[key]!.name
    })
    expect(names.filter((n) => n === "@claxedo/shared")).toHaveLength(1)
    expect(names.indexOf("@claxedo/shared")).toBe(0)
  })

  test("workspace package build order detects a dependency cycle", () => {
    const packages: Record<string, { name: string; dependencies: Record<string, string> }> = {
      "workspace-runtime": { name: "@claxedo/workspace-runtime", dependencies: { "@claxedo/a": "0.5.1" } },
      a: { name: "@claxedo/a", dependencies: { "@claxedo/workspace-runtime": "0.5.1" } },
    }
    expect(() =>
      workspacePackageBuildOrder((dir) => {
        const key = Object.keys(packages).find((name) => dir.endsWith(name))
        if (!key) throw new Error(`unexpected package dir: ${dir}`)
        return packages[key]!
      }),
    ).toThrow("cycle")
  })

  test("real workspace graph build order ends at workspace-runtime with no duplicates", () => {
    const order = workspacePackageBuildOrder()
    expect(order.at(-1)!.endsWith("workspace-runtime")).toBe(true)
    expect(new Set(order).size).toBe(order.length)
    // workspace-runtime's known @claxedo deps are all present and precede it.
    for (const dep of ["agent-event-runtime", "agent-sdk-runtime", "workspace-relay-protocol", "workspace-relay", "agent-extensions"]) {
      const depIdx = order.findIndex((dir) => dir.endsWith(dep))
      expect(depIdx).toBeGreaterThanOrEqual(0)
      expect(depIdx).toBeLessThan(order.length - 1)
    }
  })

  test("validateBuildFlags rejects --out without --bundle-only", () => {
    expect(validateBuildFlags({ bundleOnly: false, outFlag: "/tmp/out" }).ok).toBe(false)
    expect(validateBuildFlags({ bundleOnly: true, outFlag: "/tmp/out" }).ok).toBe(true)
    expect(validateBuildFlags({ bundleOnly: false, outFlag: undefined }).ok).toBe(true)
    expect(validateBuildFlags({ bundleOnly: true, outFlag: undefined }).ok).toBe(true)
    const rejected = validateBuildFlags({ bundleOnly: false, outFlag: "/tmp/out" })
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.message).toContain("--bundle-only")
  })
})
