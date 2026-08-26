import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { DEFAULT_WORKSPACE_RUNTIME_PORT } from "@claxedo/sandbox-manager"
import {
  esbuildHostBundleOptions,
  HOST_BUNDLE_FILENAME,
  OPENCODE_BINARY_FILENAME,
  WORKSPACE_RUNTIME_VERSION_FILENAME,
  hostBundleDependencies,
  sandboxImageBuildArgs,
  validateBuildFlags,
  writeWorkspaceRuntimeVersion,
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
          "@lydell/node-pty": "1.2.0-beta.14",
          "@agentclientprotocol/claude-agent-acp": "0.60.0",
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
      "@lydell/node-pty": "1.2.0-beta.14",
      "@agentclientprotocol/claude-agent-acp": "0.60.0",
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
      "@lydell/node-pty",
      "@agentclientprotocol/claude-agent-acp",
      "@agentclientprotocol/codex-acp",
    ]))
    expect(deps["@agentclientprotocol/claude-agent-acp"]).toBe("0.63.0")
    expect(deps["@anthropic-ai/claude-agent-sdk"]).toBe("0.3.220")
    expect(deps.zod).toBe("4.4.3")
  })

  test("production image starts the checkout-built workspace-runtime host", () => {
    const dockerfiles = ["../Dockerfile", "../cloudflare-worker/Dockerfile"]
      .map((file) => fs.readFileSync(path.resolve(import.meta.dirname, file), "utf8"))
    expect(dockerfiles.every((dockerfile) => dockerfile.includes("setsid env WORKSPACE_RUNTIME_PORT=2593"))).toBe(true)
    expect(dockerfiles.every((dockerfile) => dockerfile.includes("OPENCODE_URL=http://127.0.0.1:4096 workspace-runtime"))).toBe(true)
    expect(dockerfiles.every((dockerfile) =>
      dockerfile.includes(`ln -sf /opt/workspace-runtime/${HOST_BUNDLE_FILENAME} /usr/local/bin/workspace-runtime`)
    )).toBe(true)
    expect(dockerfiles.every((dockerfile) => !dockerfile.includes("claxedo-workspace-runtime-*.tgz"))).toBe(true)
    expect(dockerfiles.every((dockerfile) =>
      dockerfile.includes(`test "$(workspace-runtime --version)" = "$(cat /opt/workspace-runtime/${WORKSPACE_RUNTIME_VERSION_FILENAME})"`)
    )).toBe(true)
  })

  test("writes the runtime version consumed by the bundled host", () => {
    const outDir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "claxedo-workspace-runtime-version-"))
    const versionFile = writeWorkspaceRuntimeVersion(outDir)
    expect(versionFile).toBe(path.join(outDir, WORKSPACE_RUNTIME_VERSION_FILENAME))
    expect(fs.readFileSync(versionFile, "utf8")).toMatch(/^\d+\.\d+\.\d+\n$/)
  })

  test("production images install and smoke the checkout's Session V2 OpenCode binary", () => {
    const dockerfiles = ["../Dockerfile", "../cloudflare-worker/Dockerfile"]
      .map((file) => fs.readFileSync(path.resolve(import.meta.dirname, file), "utf8"))
    for (const dockerfile of dockerfiles) {
      expect(dockerfile).toContain(`test -x /opt/workspace-runtime/${OPENCODE_BINARY_FILENAME}`)
      expect(dockerfile).toContain(`install -m 0755 /opt/workspace-runtime/${OPENCODE_BINARY_FILENAME} /usr/local/bin/opencode`)
      expect(dockerfile).toContain("http://127.0.0.1:2593/api/session")
      expect(dockerfile).toContain("Session V2 create did not adopt the requested id")
      expect(dockerfile).toContain("Session V2 history was truncated across workspace-runtime")
      expect(dockerfile).toContain("ses_workgraph_image_failure")
      expect(dockerfile).toContain("session.next.step.failed")
      expect(dockerfile).toContain("accept-encoding: gzip")
      expect(dockerfile).toContain("setsid env OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER=true opencode serve")
      expect(dockerfile).toContain("os.killpg")
    }
    expect(dockerfiles.every((dockerfile) => !dockerfile.includes("opencode-ai@"))).toBe(true)
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
      // The second host-bundle root. It depends on workspace-runtime, so the
      // post-order walk must place it AFTER — the reverse of the old
      // "workspace-runtime is last" invariant.
      workgraph: {
        name: "@claxedo/workgraph",
        dependencies: { "@claxedo/workspace-runtime": "0.5.1" },
      },
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
    // WorkGraph's runtime adapter depends on workspace-runtime, so the runtime
    // builds first and WorkGraph closes the order. No duplicates.
    expect(before("@claxedo/workspace-runtime", "@claxedo/workgraph")).toBe(true)
    expect(names.at(-1)).toBe("@claxedo/workgraph")
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
      workgraph: { name: "@claxedo/workgraph", dependencies: { "@claxedo/workspace-runtime": "0.5.1" } },
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
      workgraph: { name: "@claxedo/workgraph", dependencies: {} },
    }
    expect(() =>
      workspacePackageBuildOrder((dir) => {
        const key = Object.keys(packages).find((name) => dir.endsWith(name))
        if (!key) throw new Error(`unexpected package dir: ${dir}`)
        return packages[key]!
      }),
    ).toThrow("cycle")
  })

  test("real workspace graph build order covers both host-bundle roots with no duplicates", () => {
    const order = workspacePackageBuildOrder()
    expect(new Set(order).size).toBe(order.length)

    const index = (name: string) => order.findIndex((dir) => path.basename(dir) === name)

    // Both host-bundle roots are present. WorkGraph joined the closure when its
    // runtime adapter moved out of workspace-runtime; without it the sandbox
    // image would bundle against a missing or stale WorkGraph dist, and every
    // dist here is gitignored so a fresh checkout would hit exactly that.
    expect(index("workspace-runtime")).toBeGreaterThanOrEqual(0)
    expect(index("workgraph")).toBeGreaterThanOrEqual(0)
    // WorkGraph depends on the runtime, so the runtime is built first.
    expect(index("workspace-runtime")).toBeLessThan(index("workgraph"))

    // workspace-runtime's known @claxedo deps are all present and precede it.
    for (const dep of ["agent-event-runtime", "agent-sdk-runtime", "workspace-relay-protocol", "workspace-relay", "agent-extensions"]) {
      expect(index(dep), dep).toBeGreaterThanOrEqual(0)
      expect(index(dep), dep).toBeLessThan(index("workspace-runtime"))
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
