import { beforeAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "../../../../..")

const PENDING_DELETION: string[] = []

const NEVER_SOURCE = ["node_modules", "out", ".artifacts", ".claude", "patches"]
const neverSource = (name: string) => NEVER_SOURCE.includes(name) || name === "dist" || name.startsWith("dist-")

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs"]

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

function isSelfReference(line: string): boolean {
  return (
    line.includes("packages/harness/src/transports/opencode-sdk/sdk-boundary.guard.test.ts") ||
    line.includes("packages/workspace-runtime/contract/opencode/")
  )
}

const COLD_REPOSITORY_READ_MS = 60_000

function readEveryRepositorySource(): void {
  for (const file of sourceFiles(repoRoot, new Set(PENDING_DELETION))) readLines(path.join(repoRoot, file))
}

describe("public SDK boundary", () => {
  beforeAll(readEveryRepositorySource, COLD_REPOSITORY_READ_MS)
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

      expect(search("dist/internal", ["packages/excluded"], root).sort((a, b) => a.localeCompare(b))).toEqual([
        `./packages/app/src/deep.ts:1:${violation.trimEnd()}`,
        `./packages/app/src/nested/deep.tsx:1:${violation.trimEnd()}`,
      ].sort((a, b) => a.localeCompare(b)))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("nothing deep-imports the SDK's unexported internal host", () => {
    const hits = [...search("dist/internal"), ...search("internal/host")].filter((line) => !isSelfReference(line))
    expect(hits).toEqual([])
  })

  test("nothing pulls EmbeddedHost out of the public SDK", () => {
    const hits = [
      ...search('EmbeddedHost } from "@opencode-ai/sdk'),
      ...search('EmbeddedHost from "@opencode-ai/sdk'),
      ...search("OpenCode.EmbeddedHost"),
    ].filter((line) => !isSelfReference(line))
    expect(hits).toEqual([])
  })

  test("nothing imports @opencode-ai/sdk by a dist path", () => {
    const hits = [...search('from "@opencode-ai/sdk/dist'), ...search('import("@opencode-ai/sdk/dist')]
      .filter((line) => !line.includes("packages/harness/src/transports/opencode-sdk/sdk-boundary.guard.test.ts"))
      .filter((line) => line.startsWith("./packages/harness/src/transports/opencode-sdk/"))
    expect(hits).toEqual([])
  })

  const LEGACY_SDK_CONSUMERS = [
    "./packages/workspace-runtime/scripts/stage-opencode-sdk.test.ts",
  ]

  test("the runtime package and its contract never import @opencode-ai/core directly", () => {
    const files = [
      ...new Set(
        search('from "@opencode-ai/core')
          .filter((line) => !line.includes("packages/harness/src/transports/opencode-sdk/sdk-boundary.guard.test.ts"))
          .filter((line) => line.startsWith("./packages/harness/src/transports/opencode-sdk/"))
            .map((line) => line.split(":")[0] ?? ""),
      ),
    ].sort((a, b) => a.localeCompare(b))
    expect(files).toEqual([])
  })

  test("the pinned SDK family is imported only by its owning package", () => {
    const hits = search('from "@opencode-ai/sdk"')
      .filter((line) => !isSelfReference(line))
      .filter((line) => !line.startsWith("./packages/harness/src/transports/opencode-sdk/"))
    const files = [...new Set(hits.map((line) => line.split(":")[0] ?? ""))].sort((a, b) => a.localeCompare(b))
    expect(files).toEqual([...LEGACY_SDK_CONSUMERS].sort((a, b) => a.localeCompare(b)))
  })
})
