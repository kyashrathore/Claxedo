import { afterAll, describe, expect, test } from "vitest"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dirname, "../../../..")
const convexRoot = path.join(repoRoot, "convex")

afterAll(() => {
  fs.rmSync(path.resolve(process.cwd(), "convex"), { force: true, recursive: true })
})

describe("Convex generated API artifacts", () => {
  test("root generated API includes every Convex module and package-local generated API is not tracked", () => {
    const modules = fs.readdirSync(convexRoot)
      .filter((file) => file.endsWith(".ts") && file !== "auth.config.ts" && file !== "env.d.ts" && file !== "schema.ts")
      .map((file) => path.basename(file, ".ts"))
      .toSorted()
    const generated = fs.readFileSync(path.join(convexRoot, "_generated", "api.d.ts"), "utf8")

    expect(modules).toEqual([
      "agentExtensionPolicies",
      "agentExtensions",
      "auditEvents",
      "channelIdentities",
      "http",
      "localHostLinks",
      "model",
      "orgs",
      "projectMemberships",
      "projects",
      "runtimeAccessTokens",
      "sandboxLeases",
      "sessions",
      "users",
      "workspaceShares",
      "workspaces",
    ])
    for (const module of modules) {
      expect(generated).toContain(`import type * as ${module} from "../${module}.js";`)
      expect(generated).toContain(`${module}: typeof ${module};`)
    }
    expect(execFileSync("git", ["ls-files", "packages/claxedo-server/convex/_generated/api.d.ts"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim()).toBe("")
  })
})
