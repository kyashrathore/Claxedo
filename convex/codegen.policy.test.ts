import { describe, expect, test } from "vitest"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dirname, "..")
const convexRoot = path.join(repoRoot, "convex")

describe("Convex generated API artifacts", () => {
  test("root generated API includes every Convex module and package-local generated API is not tracked", () => {
    const modules = fs
      .readdirSync(convexRoot)
      .filter(
        (file) =>
          file.endsWith(".ts") &&
          // Test files now live beside the functions they test (Convex's
          // documented layout); codegen never lists them in api.d.ts.
          !file.endsWith(".test.ts") &&
          file !== "auth.config.ts" &&
          file !== "env.d.ts" &&
          file !== "schema.ts" &&
          // The component app definition (D14) is deployment config, not a
          // function module: codegen never lists it in api.d.ts.
          file !== "convex.config.ts",
      )
      .map((file) => path.basename(file, ".ts"))
      .toSorted()
    const generated = fs.readFileSync(path.join(convexRoot, "_generated", "api.d.ts"), "utf8")

    expect(modules).toEqual([
      "agentExtensionPolicies",
      "agentExtensions",
      "auditEvents",
      "billing",
      "channelIdentities",
      // W6.3: the Clerk reconciliation sweep and its shared tombstone helpers.
      "clerkReconcile",
      "clerkTombstones",
      "cliSessionTokens",
      // The durable OAuth/device connect attempt store. Same cross-isolate
      // motive as `idempotency` below: the hosted control plane builds a fresh
      // connections service per request, so the kit's in-memory attempt Map was
      // always empty by the time the client polled.
      "connectionAttempts",
      // W4.4: the fenced cron lease that serializes a cron body across isolates.
      "cronLease",
      "crons",
      // Machine-wide remote access: enrollment plus the owner's
      // host↔workspace assignments.
      "hostEnrollments",
      "http",
      // W4.2: the durable idempotency store behind `DurableIdempotencyStore`.
      "idempotency",
      "migrations",
      "model",
      "orgs",
      "privateSessions",
      "projectMemberships",
      "projects",
      "runtimeAccessTokens",
      "sandboxLeases",
      "serviceInstallations",
      "sessionAccess",
      "sessionShares",
      "sessions",
      "teams",
      "usageMetering",
      "users",
      "wakes",
      "workgraphActivity",
      "workgraphArchive",
      "workgraphAttention",
      "workgraphBackground",
      "workgraphCapabilities",
      "workgraphChanges",
      "workgraphCommands",
      "workgraphConnections",
      "workgraphIntake",
      "workgraphModel",
      "workgraphOwnerDeletion",
      "workgraphRuntime",
      "workspaceShares",
      "workspaces",
    ])
    for (const module of modules) {
      expect(generated).toContain(`import type * as ${module} from "../${module}.js";`)
      expect(generated).toContain(`${module}: typeof ${module};`)
    }
    expect(
      execFileSync("git", ["ls-files", "packages/claxedo-server/convex/_generated/api.d.ts"], {
        cwd: repoRoot,
        encoding: "utf8",
      }).trim(),
    ).toBe("")
  })
})
