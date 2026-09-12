/**
 * Absence gates for the OpenCode SDK boundary.
 *
 * The published SDK tarball carries a raw-fetch host at `dist/internal/host.js`
 * that is not in its `exports` map; a bundler that ignores `exports`, or a deep
 * import, still reaches it. These greps keep it out of first-party source.
 */
import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
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
 * `dist-*` directories are build outputs (root .gitignore `dist-*`); a server
 * bundle there carries the SDK host's text inline, which is not an import.
 */
const NEVER_SOURCE = ["node_modules", "out", ".artifacts", ".claude", "patches"]
const neverSource = (name: string) => NEVER_SOURCE.includes(name) || name === "dist" || name.startsWith("dist-")

/** Only real source can import anything. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs"]

/**
 * Hidden entries are skipped the way a source search would: build state and
 * tool caches live in dotted directories, and none of them is first-party code.
 */
function sourceFiles(root: string, excluded: ReadonlySet<string>): string[] {
  const found: string[] = []
  const walk = (relative: string) => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue
      const child = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (neverSource(entry.name) || excluded.has(child)) continue
        walk(child)
        continue
      }
      if (entry.isFile() && SOURCE_EXTENSIONS.includes(path.extname(entry.name))) found.push(child)
    }
  }
  walk("")
  return found
}

/**
 * Fixed-string search over first-party source, reported as `./path:line:text`.
 *
 * Deliberately not `rg`: the guard is the only thing standing between the
 * repository and a deep SDK import, and a machine without ripgrep on PATH
 * would turn every gate below into an error instead of a verdict.
 */
function search(pattern: string, extraExcludes: readonly string[] = [], root = repoRoot): string[] {
  const excluded = new Set([...PENDING_DELETION, ...extraExcludes])
  const hits: string[] = []
  for (const file of sourceFiles(root, excluded)) {
    for (const [index, line] of readLines(path.join(root, file)).entries()) {
      if (line.includes(pattern)) hits.push(`./${file}:${index + 1}:${line}`)
    }
  }
  return hits
}

const lineCache = new Map<string, string[]>()
function readLines(file: string): string[] {
  const cached = lineCache.get(file)
  if (cached) return cached
  const lines = fs.readFileSync(file, "utf8").split("\n")
  lineCache.set(file, lines)
  return lines
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
  test("the scan reports a planted deep import and stays out of build output", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-boundary-scan-"))
    try {
      const violation = 'import { EmbeddedHost } from "@opencode-ai/sdk/dist/internal/host"\n'
      for (const file of [
        "packages/app/src/deep.ts",
        "packages/app/src/nested/deep.tsx",
        "packages/app/dist/bundled.js",
        "packages/app/node_modules/vendor/index.js",
        "packages/app/.turbo/cached.mjs",
        "packages/excluded/src/deep.ts",
        "packages/app/src/notes.md",
      ]) {
        fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true })
        fs.writeFileSync(path.join(root, file), violation)
      }

      expect(search("dist/internal", ["packages/excluded"], root)).toEqual([
        `./packages/app/src/deep.ts:1:${violation.trimEnd()}`,
        `./packages/app/src/nested/deep.tsx:1:${violation.trimEnd()}`,
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

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
   * `@opencode-ai/sdk` importers outside the owning package. Asserted exactly,
   * so a removal fails as loudly as an addition; it only ever shrinks.
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
    // Everything outside `src/opencode` consumes Claxedo ports and DTOs, not the SDK.
    const hits = search('from "@opencode-ai/sdk"')
      .filter((line) => !isSelfReference(line))
      .filter((line) => !line.startsWith("./packages/workspace-runtime/src/opencode/"))
    const files = [...new Set(hits.map((line) => line.split(":")[0]))].sort()
    expect(files).toEqual([...LEGACY_SDK_CONSUMERS].sort())
  })
})
