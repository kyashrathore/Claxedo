import { describe, expect, test } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { bundledSiblingDirs, defaultCommandRunner } from "../check-published-versions"
import {
  claxedoPackages,
  crossPinViolations,
  materializeWorkspacePins,
  missingTarballFiles,
  parseArgs,
  parsePackJson,
  protocolSpecifiers,
  publishBuildScript,
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
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", private: true, workspaces: { packages: ["packages/*"], catalog: {} } }))
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

/**
 * An npm stand-in: `view` answers from `published`, `publish` adds to it after
 * `exposeAfterViews` further views of that version, and `pack` builds a real
 * tarball of the manifest. `tar`, `git` and `cat` run for real so extraction
 * and history are covered.
 */
function fakeNpm(
  calls: string[][],
  published: Set<string>,
  packedManifests = new Map<string, Record<string, unknown>>(),
  exposeAfterViews = 0,
) {
  const pending = new Map<string, number>()
  return (cmd: string, args: string[], cwd?: string) => {
    calls.push([cmd, ...args])
    if (cmd === "tar" || cmd === "git" || cmd === "cat") return defaultCommandRunner(cmd, args, cwd)
    if (cmd === "npm" && args[0] === "view") {
      const spec = args[1] ?? ""
      const remaining = pending.get(spec)
      if (remaining !== undefined) {
        if (remaining > 0) pending.set(spec, remaining - 1)
        else {
          pending.delete(spec)
          published.add(spec)
        }
      }
      if (published.has(spec)) return spec.slice(spec.lastIndexOf("@") + 1)
      throw new Error("E404")
    }
    if (cmd === "npm" && args[0] === "publish") {
      const manifest = JSON.parse(fs.readFileSync(path.join(cwd!, "packages", workspaceDir(cwd!, args[2]), "package.json"), "utf8"))
      pending.set(`${args[2]}@${manifest.version}`, exposeAfterViews)
      return ""
    }
    if (cmd === "npm" && args[0] === "pack") {
      const dest = args[args.indexOf("--pack-destination") + 1]
      const stage = path.join(dest, "stage", "package")
      fs.mkdirSync(stage, { recursive: true })
      const manifest = JSON.parse(fs.readFileSync(path.join(cwd!, "package.json"), "utf8"))
      packedManifests.set(manifest.name, manifest)
      fs.copyFileSync(path.join(cwd!, "package.json"), path.join(stage, "package.json"))
      const filename = "fixture.tgz"
      // Relative -f: an absolute Windows path there is GNU tar remote syntax.
      defaultCommandRunner("tar", ["-czf", filename, "-C", path.join(dest, "stage"), "package"], dest)
      return JSON.stringify([{ filename, files: [{ path: "package.json" }, { path: "README.md" }, { path: "LICENSE" }] }])
    }
    return ""
  }
}

function workspaceDir(root: string, name: string) {
  for (const dir of fs.readdirSync(path.join(root, "packages"))) {
    const file = path.join(root, "packages", dir, "package.json")
    if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")).name === name) return dir
  }
  throw new Error(`no workspace package ${name}`)
}

describe("publish-claxedo-packages", () => {
  test("covers the 10 public packages, on four version tracks", () => {
    expect(claxedoPackages).toHaveLength(10)
    expect(selectPackages("all")).toEqual(claxedoPackages)
    expect(selectPackages("helpers").map((item) => item.name)).toEqual(["@claxedo/helpers"])
    expect(selectPackages("runtime").map((item) => item.name).sort()).toEqual([
      "@claxedo/agent-runtime-contract",
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
    expect(selectPackages("cli").map((item) => item.name)).toEqual(["@claxedo/cli"])
  })

  test("requires --track to name a selector the publisher knows", () => {
    expect(parseArgs(["--track", "all", "--dry-run"])).toMatchObject({ selector: "all", dryRun: true })
    expect(parseArgs(["--track", "cli"])).toMatchObject({ selector: "cli", dryRun: false })
    expect(() => parseArgs(["--dry-run"])).toThrow("(got none)")
    expect(() => parseArgs(["--track", "wakes"])).toThrow("(got wakes)")
  })

  test("keeps its packed tarballs in --work-dir instead of a temporary directory it deletes", () => {
    expect(parseArgs(["--track", "all", "--dry-run", "--work-dir", "/tmp/packs"])).toMatchObject({ workDir: "/tmp/packs" })
    expect(parseArgs(["--track", "all"]).workDir).toBeUndefined()
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

  test("the release workflow's dry run runs on a change to every public package and every sibling one bundles", () => {
    const workflow = fs.readFileSync(path.join(repoRoot, ".github/workflows/claxedo-packages-release.yml"), "utf8")
    const published = new Set(claxedoPackages.map((item) => item.name))
    const dirs = new Set(claxedoPackages.flatMap((item) => [item.dir, ...bundledSiblingDirs(repoRoot, item.dir, published)]))
    for (const dir of dirs) {
      expect(workflow.split(`- "${dir}/**"`).length - 1, `${dir} in both the push and pull_request paths`).toBe(2)
    }
    for (const track of ["helpers", "runtime", "apps", "cli"]) expect(workflow).toMatch(new RegExp(`^ +- ${track} #`, "m"))
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
    const publicNames = new Set(["@claxedo/helpers", "@claxedo/connections"])
    expect(crossPinViolations({
      dependencies: { "@claxedo/helpers": "0.3.0", hono: "4.12.32" },
      devDependencies: { "@claxedo/connections": "workspace:0.4.0" },
    }, publicNames)).toEqual([
      `dependencies.@claxedo/helpers=0.3.0 (expected ${WORKSPACE_PIN})`,
      `devDependencies.@claxedo/connections=workspace:0.4.0 (expected ${WORKSPACE_PIN})`,
    ])
    expect(crossPinViolations({ dependencies: { "@claxedo/helpers": WORKSPACE_PIN } }, publicNames)).toEqual([])
  })

  test("materializes workspace pins to the exact in-repo versions and leaves everything else alone", () => {
    const versions = new Map([["@claxedo/helpers", "0.4.0"], ["@claxedo/connections", "0.5.0"]])
    expect(materializeWorkspacePins({
      name: "@claxedo/connections",
      dependencies: { "@claxedo/helpers": "workspace:*", hono: "4.12.32" },
      devDependencies: { typescript: "catalog:" },
    }, versions)).toEqual({
      name: "@claxedo/connections",
      dependencies: { "@claxedo/helpers": "0.4.0", hono: "4.12.32" },
      devDependencies: { typescript: "catalog:" },
    })
  })

  test("drops an unpublished sibling, which the npm build inlines, from every section and pins a public one", () => {
    const versions = new Map([["@claxedo/helpers", "0.4.0"]])
    expect(materializeWorkspacePins({
      name: "@claxedo/workspace-runtime",
      dependencies: { "@claxedo/helpers": "workspace:*", "@claxedo/harness": "workspace:*", hono: "4.12.34" },
      devDependencies: { "@claxedo/helpers": "workspace:*", "@claxedo/egress-broker": "workspace:*", esbuild: "0.25.12" },
    }, versions)).toEqual({
      name: "@claxedo/workspace-runtime",
      dependencies: { "@claxedo/helpers": "0.4.0", hono: "4.12.34" },
      devDependencies: { "@claxedo/helpers": "0.4.0", esbuild: "0.25.12" },
    })
  })

  test("builds the npm variant a package names, and its one build otherwise", () => {
    expect(publishBuildScript({ scripts: { build: "tsx scripts/build.ts", "build:publish": "tsx scripts/build.ts --publish" } })).toBe("build:publish")
    expect(publishBuildScript({ scripts: { build: "bun scripts/build.ts" } })).toBe("build")
  })

  test("the packed cli and workspace-runtime manifests name no unpublished sibling", () => {
    const versions = repoVersions(repoRoot)
    for (const name of ["@claxedo/workspace-runtime", "@claxedo/cli"]) {
      const item = claxedoPackages.find((candidate) => candidate.name === name)!
      const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, item.dir, "package.json"), "utf8"))
      const packed = materializeWorkspacePins(pkg, versions)
      for (const section of ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"] as const) {
        for (const dep of Object.keys(packed[section] ?? {})) {
          if (dep.startsWith("@claxedo/")) expect(versions.has(dep), `${name} ${section}.${dep}`).toBe(true)
        }
      }
    }
  })

  test("separates breaking protocol specifiers from cosmetic devDependency ones", () => {
    expect(protocolSpecifiers({
      dependencies: { "@claxedo/helpers": "workspace:0.1.0" },
      devDependencies: { typescript: "catalog:" },
    })).toEqual({
      breaking: ["dependencies.@claxedo/helpers=workspace:0.1.0"],
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
      name === "@claxedo/connections" ? { dependencies: { "@claxedo/helpers": "workspace:*" } } : {})
    const targets = selectPackages("apps")
    const connectionsManifest = path.join(root, "packages/claxedo-connections/package.json")
    const originalConnections = fs.readFileSync(connectionsManifest, "utf8")

    const alreadyPublished = new Set(["@claxedo/channels@9.9.9"])
    const packedManifests = new Map<string, Record<string, unknown>>()
    const makeRunner = (calls: string[][]) => fakeNpm(calls, alreadyPublished, packedManifests)

    const dryCalls: string[][] = []
    const dryRun = await publishClaxedoPackages({ root, selector: "apps", dryRun: true, run: makeRunner(dryCalls), log: () => {} })
    expect(dryCalls.filter((call) => call[1] === "publish")).toHaveLength(0)
    expect(dryRun.filter((item) => item.action === "would-publish")).toHaveLength(targets.length - 1)
    expect(dryRun.find((item) => item.name === "@claxedo/channels")?.action).toBe("skipped-already-published")
    // The tarball carried the exact version; the repo kept workspace:*.
    expect(packedManifests.get("@claxedo/connections")?.dependencies).toEqual({ "@claxedo/helpers": "9.9.9" })
    expect(fs.readFileSync(connectionsManifest, "utf8")).toBe(originalConnections)

    const calls: string[][] = []
    const result = await publishClaxedoPackages({ root, selector: "apps", run: makeRunner(calls), log: () => {} })
    expect(result.map((item) => item.name).sort()).toEqual(targets.map((item) => item.name).sort())
    expect(calls.filter((call) => call[1] === "publish")).toHaveLength(targets.length - 1)
    expect(calls).not.toContainEqual([
      "npm", "publish", "--workspace", "@claxedo/channels",
      "--access", "public", "--provenance", "--tag", "latest",
    ])
    // Two apps packages plus helpers, which connections depends on and so is built first.
    expect(calls.filter((call) => call[1] === "run" && call[2] === "build")).toHaveLength(targets.length + 1)
    expect(fs.readFileSync(connectionsManifest, "utf8")).toBe(originalConnections)
  })

  test("waits for npm to serve a version it just accepted, and fails a publish npm never serves", async () => {
    const root = fixtureRepo("9.9.9")
    const sleeps: number[] = []
    const registryWait = { attempts: 4, intervalMs: 10, sleep: async (ms: number) => void sleeps.push(ms) }

    const late = await publishClaxedoPackages({
      root, only: ["@claxedo/helpers"], run: fakeNpm([], new Set(), undefined, 2), registryWait, log: () => {},
    })
    expect(late).toEqual([{ name: "@claxedo/helpers", version: "9.9.9", action: "published" }])
    expect(sleeps).toEqual([10, 10])

    sleeps.length = 0
    await expect(publishClaxedoPackages({
      root, only: ["@claxedo/helpers"], run: fakeNpm([], new Set(), undefined, 10), registryWait, log: () => {},
    })).rejects.toThrow("@claxedo/helpers: npm did not expose 9.9.9 within 0.04 s of publishing")
    expect(sleeps).toEqual([10, 10, 10])
  })

  test("builds a package's npm variant and refuses a tarball that imports a package its manifest does not declare", async () => {
    const root = fixtureRepo("9.9.9", (name) =>
      name === "@claxedo/connections"
        ? { dependencies: { hono: "4.12.34" }, scripts: { build: "echo build", "build:publish": "echo publish" } }
        : {})
    const calls: string[][] = []
    const failure = await publishClaxedoPackages({
      root,
      only: ["@claxedo/connections"],
      dryRun: true,
      run: (cmd, args, cwd) => {
        calls.push([cmd, ...args])
        if (cmd === "git" || cmd === "cat" || cmd === "tar") return defaultCommandRunner(cmd, args, cwd)
        if (cmd === "npm" && args[0] === "run") return ""
        if (cmd === "npm" && args[0] === "pack") {
          const dest = args[args.indexOf("--pack-destination") + 1]
          const stage = path.join(dest, "stage", "package")
          fs.mkdirSync(path.join(stage, "dist"), { recursive: true })
          fs.copyFileSync(path.join(cwd!, "package.json"), path.join(stage, "package.json"))
          fs.writeFileSync(path.join(stage, "dist/index.mjs"), `import { Hono } from "hono"\nimport { inner } from "@claxedo/harness/compose"\nexport { Hono, inner }\n`)
          defaultCommandRunner("tar", ["-czf", "fixture.tgz", "-C", path.join(dest, "stage"), "package"], dest)
          return JSON.stringify([{ filename: "fixture.tgz", files: [{ path: "package.json" }, { path: "README.md" }, { path: "LICENSE" }, { path: "dist/index.mjs" }] }])
        }
        throw new Error("E404")
      },
      log: () => {},
    }).then(() => undefined, (error: unknown) => (error instanceof Error ? error.message : String(error)))

    expect(calls).toContainEqual(["npm", "run", "build:publish", "--workspace", "@claxedo/connections"])
    expect(calls).not.toContainEqual(["npm", "run", "build", "--workspace", "@claxedo/connections"])
    expect(failure).toContain(
      "  - @claxedo/connections: tarball imports packages its manifest does not declare: @claxedo/harness (imported by dist/index.mjs)",
    )
  })

  test("clears a published version whose tree changed when the tree, built for npm, packs to the published bytes", async () => {
    const root = fixtureRepo("9.9.9", (name) =>
      name === "@claxedo/helpers" ? { scripts: { build: "echo build", "build:publish": "echo publish" } } : {})
    fs.writeFileSync(path.join(root, "packages/claxedo-helpers/README.md"), "changed after the version was set\n")
    const publishWith = (integrity: string) => {
      const calls: string[][] = []
      const outcome = publishClaxedoPackages({
        root,
        only: ["@claxedo/helpers"],
        dryRun: true,
        run: (cmd, args, cwd) => {
          calls.push([cmd, ...args])
          if (cmd === "git" || cmd === "cat" || cmd === "tar") return defaultCommandRunner(cmd, args, cwd)
          if (cmd === "npm" && args[0] === "view" && args[1] === "@claxedo/helpers@9.9.9") return args[2] === "dist.integrity" ? "sha512-published" : "9.9.9"
          if (cmd === "npm" && args[0] === "run") return ""
          if (cmd === "npm" && args[0] === "pack" && args.includes("--dry-run")) return JSON.stringify([{ filename: "x.tgz", integrity, files: [] }])
          if (cmd === "npm" && args[0] === "pack") {
            const dest = args[args.indexOf("--pack-destination") + 1]
            fs.mkdirSync(path.join(dest, "stage", "package"), { recursive: true })
            fs.copyFileSync(path.join(cwd!, "package.json"), path.join(dest, "stage", "package", "package.json"))
            defaultCommandRunner("tar", ["-czf", "fixture.tgz", "-C", path.join(dest, "stage"), "package"], dest)
            return JSON.stringify([{ filename: "fixture.tgz", files: [{ path: "package.json" }, { path: "README.md" }, { path: "LICENSE" }] }])
          }
          throw new Error("E404")
        },
        log: () => {},
      })
      return { calls, outcome }
    }

    const matching = publishWith("sha512-published")
    expect(await matching.outcome).toEqual([{ name: "@claxedo/helpers", version: "9.9.9", action: "skipped-already-published" }])
    const builds = matching.calls.filter((call) => call[1] === "run")
    const packs = matching.calls.findIndex((call) => call[1] === "pack")
    expect(builds).toEqual([["npm", "run", "build:publish", "--workspace", "@claxedo/helpers"]])
    expect(matching.calls.findIndex((call) => call[1] === "run")).toBeLessThan(packs)

    await expect(publishWith("sha512-other").outcome).rejects.toThrow(/@claxedo\/helpers@9\.9\.9 is already on npm but packages\/claxedo-helpers changed/)
  })

  test("refuses to publish when a sibling pin is not workspace:*", async () => {
    const root = fixtureRepo("9.9.9", (name) =>
      name === "@claxedo/connections" ? { dependencies: { "@claxedo/helpers": "0.3.0" } } : {})
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
    fs.writeFileSync(path.join(root, "packages/claxedo-helpers/README.md"), "changed after the version was set\n")
    await expect(publishClaxedoPackages({
      root,
      only: ["@claxedo/connections"],
      dryRun: true,
      run: (cmd, args, cwd) => {
        if (cmd === "git" || cmd === "cat") return defaultCommandRunner(cmd, args, cwd)
        if (cmd === "npm" && args[0] === "view" && args[1] === "@claxedo/helpers@9.9.9") return "9.9.9"
        throw new Error("E404")
      },
      log: () => {},
    })).rejects.toThrow(/@claxedo\/helpers@9\.9\.9 is already on npm but packages\/claxedo-helpers changed/)
  })

  test("reports every problem a package has, with a failing verify:publish script's own output", async () => {
    const root = fixtureRepo("9.9.9", (name) =>
      name === "@claxedo/connections"
        ? {
            dependencies: { "@claxedo/helpers": "0.3.0", "@claxedo/server": "workspace:*", "@claxedo/documents": "workspace:*" },
            scripts: { build: "echo build", "verify:publish": "tsx scripts/verify-publish.ts" },
          }
        : {})
    const verifyFailure = Object.assign(new Error("Command failed: npm run verify:publish"), {
      stdout: "\n> @claxedo/connections@9.9.9 verify:publish\n> tsx scripts/verify-publish.ts\n\n",
      stderr: [
        "Publish verification failed:",
        "- README.md public surface table is missing @claxedo/connections/extra",
        "npm error Lifecycle script `verify:publish` failed with error:",
        "npm error code 1",
      ].join("\n"),
    })
    const failure = await publishClaxedoPackages({
      root,
      selector: "apps",
      dryRun: true,
      run: (cmd, args, cwd) => {
        if (cmd === "git" || cmd === "cat" || cmd === "tar") return defaultCommandRunner(cmd, args, cwd)
        if (cmd === "npm" && args[0] === "run" && args[1] === "build") return ""
        if (cmd === "npm" && args[0] === "run" && args[1] === "verify:publish") throw verifyFailure
        if (cmd === "npm" && args[0] === "pack") {
          const dest = args[args.indexOf("--pack-destination") + 1]
          const stage = path.join(dest, "stage", "package")
          fs.mkdirSync(stage, { recursive: true })
          const manifest = JSON.parse(fs.readFileSync(path.join(cwd!, "package.json"), "utf8"))
          fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify({ ...manifest, version: "0.0.1" }))
          if (manifest.name === "@claxedo/connections") {
            fs.mkdirSync(path.join(stage, "dist"), { recursive: true })
            fs.writeFileSync(path.join(stage, "dist/index.mjs"), `export { server } from "@claxedo/server"\n`)
          }
          defaultCommandRunner("tar", ["-czf", "fixture.tgz", "-C", path.join(dest, "stage"), "package"], dest)
          return JSON.stringify([{ filename: "fixture.tgz", files: [{ path: "package.json" }, { path: "README.md" }] }])
        }
        throw new Error("E404")
      },
      log: () => {},
    }).then(() => undefined, (error: unknown) => (error instanceof Error ? error.message : String(error)))

    expect(failure).toBeDefined()
    const lines = failure!.split("\n")
    expect(lines).toContain("  - @claxedo/connections: sibling dependency is not workspace:*: dependencies.@claxedo/helpers=0.3.0 (expected workspace:*)")
    expect(lines).toContain("  - @claxedo/connections: tarball imports packages its manifest does not declare: @claxedo/server (imported by dist/index.mjs)")
    expect(lines).toContain("  - @claxedo/connections: verify:publish failed:")
    expect(lines).toContain("      - README.md public surface table is missing @claxedo/connections/extra")
    expect(failure).not.toContain("npm error")
    expect(lines).toContain("  - @claxedo/channels: tarball missing LICENSE")
    expect(lines).toContain("  - @claxedo/channels: packed version 0.0.1 != repo version 9.9.9")
  })
})
