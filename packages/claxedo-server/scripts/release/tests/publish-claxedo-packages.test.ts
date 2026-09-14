import { describe, expect, test } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  claxedoPackages,
  crossPinViolations,
  defaultCommandRunner,
  materializeWorkspacePins,
  missingTarballFiles,
  parsePackJson,
  protocolSpecifiers,
  publishClaxedoPackages,
  repoVersions,
  selectPackages,
  WORKSPACE_PIN,
} from "../publish-claxedo-packages"

const repoRoot = path.resolve(import.meta.dirname, "../../../../..")

/**
 * A fixture repo where every public package exists at `version`, with the
 * given extra manifest fields per package. Git history is real so
 * check-published-versions sees one commit that set every version.
 */
function fixtureRepo(version: string, extra: (name: string) => Record<string, unknown> = () => ({})) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-publish-test-"))
  for (const item of claxedoPackages) {
    const dir = path.join(root, item.dir)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
      name: item.name,
      version,
      scripts: { build: "echo build" },
      ...extra(item.name),
    }, null, 2))
  }
  defaultCommandRunner("git", ["init", "-q"], root)
  defaultCommandRunner("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], root)
  defaultCommandRunner("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "fixture"], root)
  return root
}

describe("publish-claxedo-packages", () => {
  test("covers the 13 public packages, on five version tracks", () => {
    expect(claxedoPackages).toHaveLength(13)
    expect(selectPackages("all")).toEqual(claxedoPackages)
    expect(selectPackages("helpers").map((item) => item.name)).toEqual(["@claxedo/helpers"])
    expect(selectPackages("runtime").map((item) => item.name).sort()).toEqual([
      "@claxedo/agent-event-runtime",
      "@claxedo/agent-runtime-contract",
      "@claxedo/agent-sdk-runtime",
      "@claxedo/sandbox-contract",
      "@claxedo/sandbox-manager",
      "@claxedo/workspace-relay",
      "@claxedo/workspace-relay-protocol",
      "@claxedo/workspace-runtime",
    ])
    expect(selectPackages("apps").map((item) => item.name).sort()).toEqual([
      "@claxedo/channels",
      "@claxedo/connections",
    ])
    expect(selectPackages("wakes").map((item) => item.name)).toEqual(["@claxedo/wakes"])
    expect(selectPackages("cli").map((item) => item.name)).toEqual(["@claxedo/cli"])
  })

  test("is listed in dependency order, so an exact @claxedo pin always resolves on npm", () => {
    const seen = new Set<string>()
    for (const item of claxedoPackages) {
      const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, item.dir, "package.json"), "utf8"))
      for (const section of ["dependencies", "peerDependencies", "optionalDependencies"]) {
        for (const dep of Object.keys(pkg[section] ?? {})) {
          if (!claxedoPackages.some((candidate) => candidate.name === dep)) continue
          expect(seen, `${item.name} depends on ${dep}, which must publish first`).toContain(dep)
        }
      }
      seen.add(item.name)
    }
  })

  test("every public package depends on its siblings through workspace:*", () => {
    const publicNames = new Set(repoVersions(repoRoot).keys())
    for (const item of claxedoPackages) {
      const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, item.dir, "package.json"), "utf8"))
      expect(crossPinViolations(pkg, publicNames), item.name).toEqual([])
      expect(pkg.private, `${item.name} must not be private`).not.toBe(true)
    }
  })

  test("flags any sibling pin that is not workspace:*", () => {
    const publicNames = new Set(["@claxedo/wakes", "@claxedo/connections"])
    expect(crossPinViolations({
      dependencies: { "@claxedo/wakes": "0.3.0", hono: "4.12.32" },
      devDependencies: { "@claxedo/connections": "workspace:0.4.0" },
    }, publicNames)).toEqual([
      `dependencies.@claxedo/wakes=0.3.0 (expected ${WORKSPACE_PIN})`,
      `devDependencies.@claxedo/connections=workspace:0.4.0 (expected ${WORKSPACE_PIN})`,
    ])
    expect(crossPinViolations({ dependencies: { "@claxedo/wakes": WORKSPACE_PIN } }, publicNames)).toEqual([])
  })

  test("materializes workspace pins to the exact in-repo versions and leaves everything else alone", () => {
    const versions = new Map([["@claxedo/wakes", "0.4.0"], ["@claxedo/connections", "0.5.0"]])
    expect(materializeWorkspacePins({
      name: "@claxedo/connections",
      dependencies: { "@claxedo/wakes": "workspace:*", hono: "4.12.32" },
      devDependencies: { typescript: "catalog:" },
    }, versions)).toEqual({
      name: "@claxedo/connections",
      dependencies: { "@claxedo/wakes": "0.4.0", hono: "4.12.32" },
      devDependencies: { typescript: "catalog:" },
    })
    expect(() => materializeWorkspacePins({
      name: "@claxedo/connections",
      dependencies: { "@claxedo/server": "workspace:*" },
    }, versions)).toThrow(/not published/)
  })

  test("drops a private sibling from devDependencies, which npm never installs, and pins a public one", () => {
    const versions = new Map([["@claxedo/wakes", "0.4.0"]])
    expect(materializeWorkspacePins({
      name: "@claxedo/cli",
      dependencies: { "@claxedo/wakes": "workspace:*" },
      devDependencies: { "@claxedo/wakes": "workspace:*", "@claxedo/host-connector": "workspace:*", esbuild: "0.25.12" },
    }, versions)).toEqual({
      name: "@claxedo/cli",
      dependencies: { "@claxedo/wakes": "0.4.0" },
      devDependencies: { "@claxedo/wakes": "0.4.0", esbuild: "0.25.12" },
    })
  })

  test("separates breaking protocol specifiers from cosmetic devDependency ones", () => {
    expect(protocolSpecifiers({
      dependencies: { "@claxedo/wakes": "workspace:0.1.0" },
      devDependencies: { typescript: "catalog:" },
    })).toEqual({
      breaking: ["dependencies.@claxedo/wakes=workspace:0.1.0"],
      cosmetic: ["devDependencies.typescript=catalog:"],
    })
  })

  test("requires README.md and LICENSE in the tarball", () => {
    expect(missingTarballFiles(["package.json", "dist/index.mjs"])).toEqual(["README.md", "LICENSE"])
    expect(missingTarballFiles(["README.md", "LICENSE"])).toEqual([])
  })

  test("tolerates npm notices before the pack JSON", () => {
    expect(parsePackJson('npm notice packing\n[{"filename":"x.tgz","files":[]}]')[0]?.filename).toBe("x.tgz")
  })

  test("packs materialized pins, restores the repo manifest, skips versions already on npm, and publishes nothing on --dry-run", async () => {
    const root = fixtureRepo("9.9.9", (name) =>
      name === "@claxedo/connections" ? { dependencies: { "@claxedo/wakes": "workspace:*" } } : {})
    const targets = selectPackages("apps")
    const connectionsManifest = path.join(root, "packages/claxedo-connections/package.json")
    const originalConnections = fs.readFileSync(connectionsManifest, "utf8")

    const alreadyPublished = new Set(["@claxedo/channels@9.9.9"])
    const packedManifests = new Map<string, Record<string, unknown>>()
    const makeRunner = (calls: string[][]) => (cmd: string, args: string[], cwd?: string) => {
      calls.push([cmd, ...args])
      // `tar` and `git` are exercised for real so the extraction and history paths are covered.
      if (cmd === "tar" || cmd === "git" || cmd === "cat") return defaultCommandRunner(cmd, args, cwd)
      if (cmd === "npm" && args[0] === "view") {
        if (alreadyPublished.has(args[1] ?? "")) return "9.9.9"
        throw new Error("E404")
      }
      if (cmd === "npm" && args[0] === "publish") {
        alreadyPublished.add(`${args[2]}@9.9.9`)
        return ""
      }
      if (cmd === "npm" && args[0] === "pack") {
        // Build a genuine tarball with the same layout npm produces.
        const dest = args[args.indexOf("--pack-destination") + 1]
        const stage = path.join(dest, "stage", "package")
        fs.mkdirSync(stage, { recursive: true })
        const manifest = JSON.parse(fs.readFileSync(path.join(cwd!, "package.json"), "utf8"))
        packedManifests.set(manifest.name, manifest)
        fs.copyFileSync(path.join(cwd!, "package.json"), path.join(stage, "package.json"))
        const filename = "fixture.tgz"
        // Relative -f for the same reason the script extracts with one: an
        // absolute Windows path there is GNU tar remote syntax.
        defaultCommandRunner("tar", ["-czf", filename, "-C", path.join(dest, "stage"), "package"], dest)
        return JSON.stringify([{ filename, files: [{ path: "package.json" }, { path: "README.md" }, { path: "LICENSE" }] }])
      }
      return ""
    }

    const dryCalls: string[][] = []
    const dryRun = await publishClaxedoPackages({ root, selector: "apps", dryRun: true, run: makeRunner(dryCalls), log: () => {} })
    expect(dryCalls.filter((call) => call[1] === "publish")).toHaveLength(0)
    expect(dryRun.filter((item) => item.action === "would-publish")).toHaveLength(targets.length - 1)
    expect(dryRun.find((item) => item.name === "@claxedo/channels")?.action).toBe("skipped-already-published")
    // The tarball carried the exact version; the repo kept workspace:*.
    expect(packedManifests.get("@claxedo/connections")?.dependencies).toEqual({ "@claxedo/wakes": "9.9.9" })
    expect(fs.readFileSync(connectionsManifest, "utf8")).toBe(originalConnections)

    const calls: string[][] = []
    const result = await publishClaxedoPackages({ root, selector: "apps", run: makeRunner(calls), log: () => {} })
    expect(result.map((item) => item.name).sort()).toEqual(targets.map((item) => item.name).sort())
    expect(calls.filter((call) => call[1] === "publish")).toHaveLength(targets.length - 1)
    expect(calls).not.toContainEqual([
      "npm", "publish", "--workspace", "@claxedo/channels",
      "--access", "public", "--provenance", "--tag", "latest",
    ])
    // Two apps packages plus wakes, which connections depends on and so is built first.
    expect(calls.filter((call) => call[1] === "run" && call[2] === "build")).toHaveLength(targets.length + 1)
    expect(fs.readFileSync(connectionsManifest, "utf8")).toBe(originalConnections)
  })

  test("refuses to publish when a sibling pin is not workspace:*", async () => {
    const root = fixtureRepo("9.9.9", (name) =>
      name === "@claxedo/connections" ? { dependencies: { "@claxedo/wakes": "0.3.0" } } : {})
    await expect(publishClaxedoPackages({
      root,
      only: ["@claxedo/connections"],
      dryRun: true,
      run: (cmd, args, cwd) => {
        if (cmd === "git" || cmd === "cat") return defaultCommandRunner(cmd, args, cwd)
        throw new Error("E404")
      },
      log: () => {},
    })).rejects.toThrow(/sibling dependency is not workspace:\*/)
  })

  test("refuses to run while a published version has unreleased changes behind it", async () => {
    const root = fixtureRepo("9.9.9")
    fs.writeFileSync(path.join(root, "packages/wakes/README.md"), "changed after the version was set\n")
    await expect(publishClaxedoPackages({
      root,
      only: ["@claxedo/connections"],
      dryRun: true,
      run: (cmd, args, cwd) => {
        if (cmd === "git" || cmd === "cat") return defaultCommandRunner(cmd, args, cwd)
        if (cmd === "npm" && args[0] === "view" && args[1] === "@claxedo/wakes@9.9.9") return "9.9.9"
        throw new Error("E404")
      },
      log: () => {},
    })).rejects.toThrow(/@claxedo\/wakes@9\.9\.9 is already on npm but packages\/wakes changed/)
  })
})
