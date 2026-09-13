import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { build as esbuildBuild } from "esbuild"
import { workspaceRuntimeRoot } from "../../../src/hosts/workspace-runtime/startup"
import {
  esbuildHostBundleOptions,
  HOST_BUNDLE_FILENAME,
  IMAGE_SMOKE_FILENAME,
  WORKSPACE_RUNTIME_VERSION_FILENAME,
  hostBundleDependencies,
  hostBundlePackageRoots,
  sandboxImageBuildArgs,
  validateBuildFlags,
  writeWorkspaceRuntimeVersion,
  workspacePackageBuildOrder,
  assertHostBundleDependencies,
} from "../build-sandbox-image"

const runtimeRoots = [path.resolve(import.meta.dirname, "../../../../workspace-runtime")]

describe("build-sandbox-image", () => {
  test("the Node image supports the SDK syntax and SQLite native prebuild", () => {
    const dockerfile = fs.readFileSync(path.join(import.meta.dirname, "../Dockerfile"), "utf8")
    // The major is the contract — the SDK syntax and the SQLite prebuild — and
    // pinning the patch here makes every base-image bump a test edit.
    expect(dockerfile).toMatch(/^FROM node:24\.\d+\.\d+-trixie-slim$/m)
  })
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
    expect(options.metafile).toBe(true)
    expect(options.platform).toBe("node")
    expect(options.outfile).toBe(`/out/${HOST_BUNDLE_FILENAME}`)
    // The workspace-only plugin externalizes every non-@claxedo import.
    const plugin = options.plugins[0]
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
          "@claxedo/agent-sdk-runtime": "0.5.1",
          "@opencode-ai/plugin": "0.0.0-beta-18684",
          "@opencode-ai/sdk": "0.0.0-beta-18684",
          koffi: "3.1.6",
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
      return packages[key]
    }, runtimeRoots)
    expect(deps).toEqual({
      "better-sqlite3": "12.10.0",
      "@lydell/node-pty": "1.2.0-beta.14",
      hono: "4.12.12",
      "just-bash": "3.0.1",
      "@opencode-ai/plugin": "0.0.0-beta-18684",
      "@opencode-ai/sdk": "0.0.0-beta-18684",
      koffi: "3.1.6",
    })
  })

  test("missing image dependency pins fail loudly", () => {
    expect(() => hostBundleDependencies(() => ({ dependencies: { "better-sqlite3": "12.10.0" } })))
      .toThrow("missing image dependency")
  })

  test("external pins include every host root while the runtime keeps pin priority", () => {
    const packages = {
      adapter: { dependencies: { "remote-transport": "2.0.0", "better-sqlite3": "11.0.0" } },
      runtime: { dependencies: { "better-sqlite3": "12.10.0", "@lydell/node-pty": "1.2.0-beta.14" } },
    }
    const dependencies = hostBundleDependencies((dir) => packages[path.basename(dir) as keyof typeof packages], ["/fixtures/adapter", "/fixtures/runtime"])
    expect(dependencies).toEqual({
      "remote-transport": "2.0.0",
      "better-sqlite3": "12.10.0",
      "@lydell/node-pty": "1.2.0-beta.14",
    })
  })

  test("standalone image dependencies resolve workspace catalog specifiers", () => {
    const deps = hostBundleDependencies(() => ({
      name: "@claxedo/catalog-fixture",
      dependencies: {
        "better-sqlite3": "12.10.0",
        "@lydell/node-pty": "1.2.0-beta.14",
        "@agentclientprotocol/claude-agent-acp": "0.15.1",
        "@agentclientprotocol/codex-acp": "0.17.1",
        "drizzle-orm": "catalog:",
      },
    }), [workspaceRuntimeRoot()], { "drizzle-orm": "1.0.0-rc.2" })
    expect(deps["drizzle-orm"]).toBe("1.0.0-rc.2")
  })

  test("standalone image dependencies omit monorepo-only workspace specifiers", () => {
    const deps = hostBundleDependencies(() => ({
      name: "@claxedo/workspace-fixture",
      dependencies: {
        "better-sqlite3": "12.10.0",
        "@lydell/node-pty": "1.2.0-beta.14",
        "@agentclientprotocol/claude-agent-acp": "0.15.1",
        "@agentclientprotocol/codex-acp": "0.17.1",
        "@opencode-ai/sdk-next": "workspace:*",
        opencode: "workspace:*",
      },
    }), [workspaceRuntimeRoot()])
    expect(deps).not.toHaveProperty("@opencode-ai/sdk-next")
    expect(deps).not.toHaveProperty("opencode")
    expect(Object.values(deps).some((version) => version.startsWith("workspace:"))).toBe(false)
  })

  test("a missing workspace catalog pin fails before Docker or npm", () => {
    expect(() => hostBundleDependencies(() => ({
      name: "@claxedo/catalog-fixture",
      dependencies: {
        "better-sqlite3": "12.10.0",
        "@lydell/node-pty": "1.2.0-beta.14",
        "@agentclientprotocol/claude-agent-acp": "0.15.1",
        "@agentclientprotocol/codex-acp": "0.17.1",
        "drizzle-orm": "catalog:",
      },
    }), [workspaceRuntimeRoot()], {})).toThrow(
      "workspace catalog has no concrete version for image dependency: drizzle-orm",
    )
  })

  test("real workspace-runtime package.json satisfies the image dependency pins", () => {
    const deps = hostBundleDependencies()
    expect(Object.keys(deps)).toEqual(expect.arrayContaining([
      "better-sqlite3",
      "@lydell/node-pty",
    ]))
    expect(deps["@anthropic-ai/claude-agent-sdk"]).toBe("0.3.220")
    expect(deps.zod).toBe("4.4.3")
    expect(deps["@opencode-ai/sdk"]).toBe("0.0.0-beta-18684")
  })

  test("the enabled image adds the feature package root while the disabled image does not", () => {
    const disabled = hostBundlePackageRoots(false)
    expect(disabled.map((dir) => path.basename(dir))).toContain("claxedo-mcp")
    const enabled = hostBundlePackageRoots(true)
    expect(disabled.some((root) => root.endsWith("claxedo-local-server"))).toBe(false)
    expect(enabled.filter((root) => root.endsWith("claxedo-local-server"))).toHaveLength(1)
    expect(enabled).toHaveLength(disabled.length + 1)
  })

  test("production image starts the checkout-built workspace-runtime host", () => {
    const dockerfiles = ["../Dockerfile", "../cloudflare-worker/Dockerfile"]
      .map((file) => fs.readFileSync(path.resolve(import.meta.dirname, file), "utf8"))
    expect(dockerfiles.every((dockerfile) => dockerfile.includes(`RUN node /opt/workspace-runtime/${IMAGE_SMOKE_FILENAME}`))).toBe(true)
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

  test("production images do not bundle or start an agent provider", () => {
    const dockerfiles = ["../Dockerfile", "../cloudflare-worker/Dockerfile"]
      .map((file) => fs.readFileSync(path.resolve(import.meta.dirname, file), "utf8"))
    for (const dockerfile of dockerfiles) {
      expect(dockerfile).not.toContain("opencode serve")
      expect(dockerfile).not.toContain("/api/session")
      expect(dockerfile).not.toContain("/usr/local/bin/opencode")
      expect(dockerfile).toContain(`RUN node /opt/workspace-runtime/${IMAGE_SMOKE_FILENAME}`)
    }
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
    const order = workspacePackageBuildOrder((dir) => packages[dirKey(dir)], runtimeRoots)
    const names = order.map((dir) => packages[dirKey(dir)].name)

    // Every dependency comes before its dependent.
    const before = (a: string, b: string) => names.indexOf(a) < names.indexOf(b)
    expect(before("@claxedo/agent-event-runtime", "@claxedo/agent-sdk-runtime")).toBe(true)
    expect(before("@claxedo/agent-sdk-runtime", "@claxedo/workspace-runtime")).toBe(true)
    expect(before("@claxedo/workspace-relay-protocol", "@claxedo/workspace-relay")).toBe(true)
    expect(before("@claxedo/workspace-relay", "@claxedo/workspace-runtime")).toBe(true)
    // This graph has one root, so it closes the order.
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
      return packages[key]
    }, runtimeRoots)
    const names = order.map((dir) => {
      const key = Object.keys(packages).find((name) => dir.endsWith(name))!
      return packages[key].name
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
        return packages[key]
      }, runtimeRoots),
    ).toThrow("cycle")
  })

  test("real workspace graph build order covers the host-bundle root with no duplicates", () => {
    const order = workspacePackageBuildOrder()
    expect(new Set(order).size).toBe(order.length)

    const index = (name: string) => order.findIndex((dir) => path.basename(dir) === name)

    // The host-bundle root is present. Every dist here is gitignored, so a
    // missing root would leave a fresh checkout bundling against a stale dist.
    expect(index("workspace-runtime")).toBeGreaterThanOrEqual(0)
    expect(index("opencode-server-adapter")).toBeGreaterThanOrEqual(0)
    expect(index("opencode-server-adapter")).toBeLessThan(index("workspace-runtime"))
    expect(index("claxedo-mcp")).toBeGreaterThan(index("workspace-runtime"))

    // workspace-runtime's known @claxedo deps are all present and precede it.
    for (const dep of ["agent-event-runtime", "agent-sdk-runtime", "workspace-relay-protocol", "workspace-relay"]) {
      expect(index(dep), dep).toBeGreaterThanOrEqual(0)
      expect(index(dep), dep).toBeLessThan(index("workspace-runtime"))
    }
  })

  test("actual bundle metadata rejects undeclared external imports and allows builtins and declared subpaths", async () => {
    const result = await esbuildBuild({
      ...esbuildHostBundleOptions({ entry: "unused", outfile: "/unused/host.mjs" }),
      entryPoints: undefined,
      stdin: { contents: 'import "node:fs"; import "path"; import "@example/runtime/subpath"; import "drizzle-orm/node-postgres";' },
      write: false,
    })
    expect(() => assertHostBundleDependencies(result.metafile!, { "@example/runtime": "1.0.0" }))
      .toThrow("Host bundle has undeclared external dependencies: drizzle-orm/node-postgres")
    expect(() => assertHostBundleDependencies(result.metafile!, { "@example/runtime": "1.0.0", "drizzle-orm": "0.44.0" }))
      .not.toThrow()
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
