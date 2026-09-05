/**
 * Permanent absence gates for the OpenCode SDK boundary (Unit 8, Decision 15).
 *
 * The hazard is specific and real: the published SDK tarball CONTAINS a raw
 * `fetch` at `dist/internal/host.js`. It is not in the package `exports` map,
 * so Node ESM refuses it — but a bundler that disrespects `exports`, or a
 * deliberate deep import, reaches it. Using it would make the public
 * installation cosmetic, which is the exact outcome the plan's Alternatives
 * section rejects. A grep is cheap; discovering this in a shipped artifact is
 * not.
 *
 * These gates enforce what is already true rather than aspirational state, and
 * the fork allowlist below ratchets to empty when Unit 8 deletes it.
 */
import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import * as path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "../../../..")

/**
 * Source trees excluded from the scan. Empty since the vendored runtime was
 * retired; kept so any future exclusion is an explicit, reviewed entry.
 */
const PENDING_DELETION: string[] = []

/**
 * Directories that never contain first-party source. `patches/` matters here:
 * it holds upstream diffs for unrelated packages (an ai-sdk patch touches its
 * own `dist/internal/`), and matching those would be noise, not a finding.
 */
const NEVER_SOURCE = ["node_modules", "dist", "out", ".artifacts", "dist-node", ".claude", "patches"]

/** Only real source can import anything. */
const SOURCE_GLOBS = ["*.ts", "*.tsx", "*.js", "*.mjs", "*.cjs"]

function search(pattern: string, extraExcludes: readonly string[] = []): string[] {
  const args = ["--fixed-strings", "--line-number", "--no-heading", pattern, "."]
  for (const glob of SOURCE_GLOBS) args.push("--glob", glob)
  for (const dir of NEVER_SOURCE) args.push("--glob", `!**/${dir}/**`)
  // Exact paths: excluding every directory named `opencode` accidentally
  // excluded the new canonical owner as well as the old upstream tree.
  for (const dir of [...PENDING_DELETION, ...extraExcludes]) args.push("--glob", `!${dir}/**`)
  try {
    const out = execFileSync("rg", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
    return out.split("\n").filter(Boolean)
  } catch (error) {
    // rg exits 1 with no output when nothing matches, which is the pass case.
    const status = (error as { status?: number }).status
    if (status === 1) return []
    throw error
  }
}

/** Hits inside this package's own docs/tests, which must NAME the hazard. */
function isSelfReference(line: string): boolean {
  return (
    line.includes("packages/workspace-runtime/src/opencode/sdk-boundary.guard.test.ts") ||
    line.includes("packages/workspace-runtime/contract/opencode/") ||
    line.includes("docs/architecture/opencode-embedded-sdk-contract.md")
  )
}

describe("public SDK boundary", () => {
  test("nothing deep-imports the SDK's unexported internal host", () => {
    const hits = [...search("dist/internal"), ...search("internal/host")].filter((line) => !isSelfReference(line))
    expect(hits).toEqual([])
  })

  test("nothing pulls EmbeddedHost out of the public SDK", () => {
    // Scoped to the SDK import forms deliberately: matching the bare word
    // would flag any unrelated `EmbeddedHost` symbol and make this gate cry wolf.
    const hits = [
      ...search('EmbeddedHost } from "@opencode-ai/sdk'),
      ...search('EmbeddedHost from "@opencode-ai/sdk'),
      ...search("OpenCode.EmbeddedHost"),
    ].filter((line) => !isSelfReference(line))
    expect(hits).toEqual([])
  })

  test("nothing imports @opencode-ai/sdk by a dist path", () => {
    const hits = [...search('from "@opencode-ai/sdk/dist'), ...search('import("@opencode-ai/sdk/dist')]
      .filter((line) => !line.includes("packages/workspace-runtime/src/opencode/sdk-boundary.guard.test.ts"))
      .filter((line) => line.startsWith("./packages/workspace-runtime/src/opencode/"))
    expect(hits).toEqual([])
  })

  /**
   * Legacy `@opencode-ai/sdk` consumers still outside the owning package.
   *
   * This list only ever shrinks — Unit 2b migrates these to Claxedo DTOs. It is
   * asserted exactly, so removing a consumer without updating the list fails
   * just as loudly as adding one.
   */
  const LEGACY_SDK_CONSUMERS = [
    // A string inside a scanner's test fixture, not a real import.
    "./packages/claxedo-app/src/architecture/scanners.test.ts",
    "./packages/workspace-runtime/scripts/stage-opencode-sdk.test.ts",
  ]

  test("the runtime package and its contract never import @opencode-ai/core directly", () => {
    const files = [
      ...new Set(
        search('from "@opencode-ai/core')
          .filter((line) => !line.includes("packages/workspace-runtime/src/opencode/sdk-boundary.guard.test.ts"))
          .filter((line) => line.startsWith("./packages/workspace-runtime/src/opencode/"))
          .map((line) => line.split(":")[0]),
      ),
    ].sort()
    expect(files).toEqual([])
  })

  test("the pinned SDK family is imported only by its owning package", () => {
    // `@claxedo/workspace-runtime/opencode` is the sole owner of the public SDK
    // (Decision 2). Everything else consumes Claxedo ports and DTOs.
    const hits = search('from "@opencode-ai/sdk"')
      .filter((line) => !isSelfReference(line))
      .filter((line) => !line.startsWith("./packages/workspace-runtime/src/opencode/"))
    const files = [...new Set(hits.map((line) => line.split(":")[0]))].sort()
    expect(files).toEqual([...LEGACY_SDK_CONSUMERS].sort())
  })
})
