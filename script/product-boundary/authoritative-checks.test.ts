import fs from "node:fs"
import path from "node:path"

import { describe, expect, test } from "vitest"

import { AUTHORITATIVE_CHECKS, runAuthoritativeChecks, type AuthoritativeCheck } from "./authoritative-checks"
import { REPO_ROOT } from "./closure"

describe("product boundary authoritative checks", () => {
  test("every product policy composes existing gates without recursing into verify:closure", () => {
    expect(Object.keys(AUTHORITATIVE_CHECKS).sort()).toEqual([
      "@claxedo/app",
      "@claxedo/desktop",
      "@claxedo/host-connector",
      "@claxedo/local-server",
      "@claxedo/server",
    ])

    const commands = Object.values(AUTHORITATIVE_CHECKS).flat().map((check) => check.command.join(" "))
    expect(commands.some((command) => command.includes("local-entry-closure.guard.test.ts"))).toBe(true)
    expect(commands.some((command) => command.includes("local-closure.test.ts"))).toBe(true)
    expect(commands.some((command) => command.includes("connector-closure.test.ts"))).toBe(true)
    expect(commands.some((command) => command.includes("deployment-closures.test.ts"))).toBe(true)
    expect(commands.some((command) => command.includes("worker.import-graph.test.ts"))).toBe(true)
    expect(commands.some((command) => command.includes("renderer-entry-closure.guard.test.ts"))).toBe(true)
    expect(commands.some((command) => command.includes("package-structure.test.ts"))).toBe(true)
    expect(commands.some((command) => command.includes("build:local"))).toBe(true)
    expect(commands.some((command) => command.includes("build:marker-control"))).toBe(true)
    expect(commands.some((command) => command.includes("check:local-bundle"))).toBe(true)
    expect(AUTHORITATIVE_CHECKS["@claxedo/host-connector"]?.map((check) => check.label)).toEqual([
      "host-connector production build",
      "host-connector built entry smoke",
      "host-connector source closure",
    ])
    expect(AUTHORITATIVE_CHECKS["@claxedo/local-server"]?.map((check) => check.label)).toEqual([
      "local-server production build",
      "local-server built entry smoke",
      "local-server published and self-hosted closure",
    ])
    expect(AUTHORITATIVE_CHECKS["@claxedo/server"]?.map((check) => check.label)).toEqual([
      "hosted Node production build",
      "hosted Node built entry smoke",
      "hosted workerd production build",
      "hosted workerd built entry smoke",
      "cloud and self-hosted deployment closures",
      "self-hosted local-server public subpath",
    ])
    expect(commands.filter((command) => command.includes("verify:closure"))).toEqual([])
  })

  test("runs a product's checks in order and stops on the first failure", () => {
    const seen: AuthoritativeCheck[] = []
    const ok = runAuthoritativeChecks("@claxedo/app", (check) => {
      seen.push(check)
      return seen.length === 2 ? 7 : 0
    })

    expect(ok).toBe(false)
    expect(seen.map((check) => check.label)).toEqual([
      "local renderer source closure",
      "local renderer build",
    ])
  })

  test("the emitted check always uses the known-positive marker build", () => {
    const check = AUTHORITATIVE_CHECKS["@claxedo/app"]!.find((item) => item.label === "local emitted-bundle identity")
    expect(check?.env).toEqual({ CLAXEDO_MARKER_CONTROL_DIR: "dist-marker-control" })
  })

  test("a product with no authoritative command cannot pass", () => {
    expect(() => runAuthoritativeChecks("@claxedo/missing", () => 0)).toThrow("has no authoritative checks")
  })

  test("the main CI workflow invokes every product's public closure command", () => {
    const workflow = fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/test.yml"), "utf8")

    expect(workflow).toContain("working-directory: packages/claxedo-app\n        run: bun run verify:closure")
    for (const packageDirectory of [
      "claxedo-local-server",
      "claxedo-host-connector",
      "claxedo-server",
      "claxedo-desktop",
    ]) {
      expect(workflow).toContain(`bun run --cwd packages/${packageDirectory} verify:closure`)
    }
  })
})
