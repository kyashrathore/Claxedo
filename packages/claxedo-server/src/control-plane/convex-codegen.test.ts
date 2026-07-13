import { describe, expect, test } from "vitest"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dirname, "../../../..")
const convexRoot = path.join(repoRoot, "convex")

describe("Convex generated API artifacts", () => {
  test("root generated API includes every Convex module and package-local generated API is not tracked", () => {
    const modules = fs.readdirSync(convexRoot)
      .filter((file) =>
        file.endsWith(".ts") &&
        file !== "auth.config.ts" &&
        file !== "env.d.ts" &&
        file !== "schema.ts" &&
        // The component app definition (D14) is deployment config, not a
        // function module: codegen never lists it in api.d.ts.
        file !== "convex.config.ts")
      .map((file) => path.basename(file, ".ts"))
      .toSorted()
    const generated = fs.readFileSync(path.join(convexRoot, "_generated", "api.d.ts"), "utf8")

    expect(modules).toEqual([
      "agentExtensionPolicies",
      "agentExtensions",
      "auditEvents",
      "billing",
      "channelIdentities",
      "crons",
      "http",
      "localHostLinks",
      "migrations",
      "model",
      "orgs",
      "projectMemberships",
      "projects",
      "runtimeAccessTokens",
      "sandboxLeases",
      "sessions",
      "users",
      "workgraphArchive",
      "workgraphAttention",
      "workgraphBackground",
      "workgraphChanges",
      "workgraphCommands",
      "workgraphConnections",
      "workgraphIntake",
      "workgraphModel",
      "workgraphNotifications",
      "workgraphOwnerDeletion",
      "workgraphRuntime",
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
