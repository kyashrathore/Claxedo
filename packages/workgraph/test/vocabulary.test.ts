import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const scopes = ["convex", "packages/workgraph", "packages/claxedo-server/src/hosts/workgraph", "packages/claxedo-mcp", "packages/claxedo-app/src/features/workgraph"]

// Stable content anchors preserve genuine retry language and persisted
// pre-rename storage names without coupling the gate to line numbers.
const allowed = [
  /^convex\/auditEvents\.ts:\d+:.*attempted/i,
  /^packages\/claxedo-app\/src\/features\/workgraph\/waiting\/item-dialogs\.vitest\.tsx:\d+:.*attempted/i,
  /^packages\/claxedo-mcp\/docs\/architecture\.md:\d+:.*attempting/i,
  /^packages\/claxedo-server\/src\/workgraph-host\/convex-store\.test\.ts:\d+:.*Fresh attempt/i,
  /^packages\/claxedo-server\/src\/workgraph-host\/hosted\.ts:\d+:.*\battempt\b/i,
  /^packages\/claxedo-server\/src\/workgraph-host\/session-intake\.test\.ts:\d+:.*\battempt\b/i,
  /^packages\/workgraph\/src\/adapters\/sqlite\/legacy-migration\.ts:\d+:.*attempt/i,
  /^packages\/workgraph\/src\/adapters\/sqlite\/schema\.ts:\d+:.*(wg_v2_attempts|attempt_(number|id)|source_attempt_id|current_attempt_id)/i,
  /^packages\/workgraph\/src\/adapters\/sqlite\/source-planning-runtime\.test\.ts:\d+:.*\battempt/i,
  /^packages\/workgraph\/src\/contracts\/run-operation\.ts:\d+:.*attempts > RUN_RESUME_MAX/i,
  /^packages\/workgraph\/src\/db\/schema\.ts:\d+:.*attempts_current|attempt_id/i,
  /^packages\/workgraph\/test\/sqlite-legacy-migration\.test\.ts:\d+:.*attempt/i,
  /^packages\/workgraph\/test\/sqlite-schema-v2\.test\.ts:\d+:.*attempt/i,
]

describe("WorkGraph vocabulary", () => {
  it("rejects a reintroduced domain identifier while accepting retry counters", () => {
    expect(isUnexpected("convex/example.ts:1:const attemptId = input.attemptId")).toBe(true)
    expect(isUnexpected("convex/example.ts:1:attempt_count: row.attemptCount")).toBe(false)
  })

  it("keeps the execution entity vocabulary distinct from retry counters", () => {
    // git grep, not rg: GitHub-hosted runners ship git but not ripgrep, and
    // this guard must run in CI. `-I` skips binaries; pathspec magic excludes
    // this file the way rg's --glob negation did. `--no-index` searches the
    // working tree without requiring a .git dir, so the guard also runs on
    // synced copies (crabbox CI-sim boxes) that have no repository.
    const result = spawnSync(
      "git",
      ["grep", "--no-index", "--exclude-standard", "-nI", "[Aa]ttempt", "--", ...scopes, ":(exclude)packages/workgraph/test/vocabulary.test.ts"],
      {
        cwd: repository,
        encoding: "utf8",
      },
    )
    expect(result.status, result.error?.message ?? "git grep must exit 0 (matches) or 1 (no matches)").not.toBeNull()
    expect([0, 1], result.error?.message ?? result.stderr).toContain(result.status)
    expect(result.stderr).toBe("")

    const unexpected = result.stdout.trim().split("\n").filter(Boolean).filter(isUnexpected)
    expect(unexpected).toEqual([])
  })
})

function isUnexpected(line: string) {
  if (allowed.some((pattern) => pattern.test(line))) return false
  return /[Aa]ttempt/.test(line.replace(/attempt_count|attemptCount|resume_attempts|resumeAttempts|attempts:|\.attempts/gi, ""))
}
