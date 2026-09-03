import { describe, expect, test } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  claxedoPackages,
  crossPinViolations,
  defaultCommandRunner,
  missingTarballFiles,
  parsePackJson,
  protocolSpecifiers,
  publishClaxedoPackages,
  repoVersions,
  selectPackages,
} from "../publish-claxedo-packages"
import { runtimePackages } from "../publish-runtime-packages"

const repoRoot = path.resolve(import.meta.dirname, "../../../../..")

describe("publish-claxedo-packages", () => {
  test("covers exactly the 12 public packages, and `others` is the set the runtime script misses", () => {
    expect(claxedoPackages).toHaveLength(12)
    const runtimeNames = new Set(runtimePackages.map((item) => item.name))
    expect(selectPackages("runtime-family").map((item) => item.name).sort())
      .toEqual([...runtimeNames].sort())
    expect(selectPackages("others").map((item) => item.name).sort()).toEqual([
      "@claxedo/channels",
      "@claxedo/connections",
      "@claxedo/mcp",
      "@claxedo/sandbox-contract",
      "@claxedo/sandbox-manager",
      "@claxedo/wakes",
    ])
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

  test("every public package's @claxedo/* pins match the in-repo versions", () => {
    const versions = repoVersions(repoRoot)
    for (const item of claxedoPackages) {
      const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, item.dir, "package.json"), "utf8"))
      expect(crossPinViolations(pkg, versions), item.name).toEqual([])
    }
  })

  test("no public package carries a workspace:/catalog: specifier consumers would install", () => {
    for (const item of claxedoPackages) {
      const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, item.dir, "package.json"), "utf8"))
      expect(protocolSpecifiers(pkg).breaking, item.name).toEqual([])
      expect(pkg.private, `${item.name} must not be private`).not.toBe(true)
    }
  })

  test("flags a stale cross-pin", () => {
    const versions = new Map([["@claxedo/wakes", "0.4.0"]])
    expect(crossPinViolations({ dependencies: { "@claxedo/wakes": "0.3.0", hono: "4.12.32" } }, versions))
      .toEqual(["dependencies.@claxedo/wakes=0.3.0 (expected 0.4.0)"])
    expect(crossPinViolations({ dependencies: { "@claxedo/wakes": "0.4.0" } }, versions)).toEqual([])
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

  test("skips versions already on npm, publishes the rest, and publishes nothing on --dry-run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-publish-test-"))
    const targets = selectPackages("others")
    for (const item of targets) {
      const dir = path.join(root, item.dir)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
        name: item.name,
        version: "9.9.9",
        scripts: { build: "echo build" },
      }, null, 2))
    }
    // The full version map is read from every public package, so the runtime
    // six runtime-family packages need to exist in the fixture too.
    for (const item of selectPackages("runtime-family")) {
      const dir = path.join(root, item.dir)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
        name: item.name,
        version: "9.9.9",
        scripts: { build: "echo build" },
      }, null, 2))
    }

    const alreadyPublished = new Set(["@claxedo/wakes@9.9.9"])
    const makeRunner = (calls: string[][]) => (cmd: string, args: string[], cwd?: string) => {
      calls.push([cmd, ...args])
      // `tar` is exercised for real so the extraction path is covered.
      if (cmd === "tar") return defaultCommandRunner(cmd, args, cwd)
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
        const dest = args[args.indexOf("--pack-destination") + 1]!
        const stage = path.join(dest, "stage", "package")
        fs.mkdirSync(stage, { recursive: true })
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
    const dryRun = await publishClaxedoPackages({
      root,
      selector: "others",
      dryRun: true,
      run: makeRunner(dryCalls),
      log: () => {},
    })
    expect(dryCalls.filter((call) => call[1] === "publish")).toHaveLength(0)
    expect(dryRun.filter((item) => item.action === "would-publish")).toHaveLength(targets.length - 1)
    expect(dryRun.find((item) => item.name === "@claxedo/wakes")?.action).toBe("skipped-already-published")

    const calls: string[][] = []
    const result = await publishClaxedoPackages({ root, selector: "others", run: makeRunner(calls), log: () => {} })
    expect(result.map((item) => item.name).sort()).toEqual(targets.map((item) => item.name).sort())
    expect(calls.filter((call) => call[1] === "publish")).toHaveLength(targets.length - 1)
    expect(calls).not.toContainEqual([
      "npm", "publish", "--workspace", "@claxedo/wakes",
      "--access", "public", "--provenance", "--tag", "latest",
    ])
    expect(calls.filter((call) => call[1] === "run" && call[2] === "build")).toHaveLength(targets.length)
  })

  test("refuses to publish when a cross-pin is stale", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-publish-stale-"))
    for (const item of claxedoPackages) {
      const dir = path.join(root, item.dir)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
        name: item.name,
        version: "9.9.9",
        ...(item.name === "@claxedo/mcp" ? { dependencies: { "@claxedo/wakes": "0.3.0" } } : {}),
      }, null, 2))
    }
    await expect(publishClaxedoPackages({
      root,
      only: ["@claxedo/mcp"],
      dryRun: true,
      run: () => "",
      log: () => {},
    })).rejects.toThrow(/stale @claxedo\/\* cross-pin/)
  })
})
