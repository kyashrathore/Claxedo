import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")
const THIS_FILE = "script/agent-plugins-retirement.test.ts"
/** Replayed session logs quote whatever the agent said at the time, retired names included. */
const TRANSCRIPT_LAB_FIXTURE = "packages/claxedo-app/e2e/corpus/seeds/transcript-lab-fixture.json"
const EXPECTED_ROOTS = [".github", "packages", "script", "public-docs"] as const
const TEXT_EXTENSIONS = new Set([".json", ".md", ".yml", ".yaml", ".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".sh", ".ps1"])
const ROOT_TEXT_FILES = new Set([".dockerignore", ".gitignore", "README.md"])

const RETIRED = [
  /@claxedo\/agent-extensions/i,
  /packages\/agent-extensions/i,
  /features\/extensions\/marketplace/i,
  /\/api\/claxedo\/agent-config\/extensions/i,
  /\bagent_extension(?:s|_[a-z_]+)?\b/i,
  /\bagentExtensions?\b/,
  /\bAgentExtensions?\b/,
  /\bsyncAgentExtensions\b/,
  /\bAgentExtension(?:Install|Policy|Scope|State|Runtime|Catalog)\b/,
  /\bAgent Extensions?\b/i,
] as const

export type RetirementFinding = { file: string; token: string }

export function retiredAgentExtensionFindings(files: Array<{ file: string; text: string }>): RetirementFinding[] {
  return files.flatMap(({ file, text }) => RETIRED.flatMap((pattern) => {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`
    return [...text.matchAll(new RegExp(pattern.source, flags))].map((match) => ({ file, token: match[0] }))
  }))
}

/**
 * Every retired name contains "extension" in some case, so one scan for it
 * picks the files worth matching: about 185 of the 8,200 the scan reads.
 */
const CANDIDATE = /extension/i

function scannedFiles() {
  const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf8",
  })
  return listed.split("\n").filter((file) => file
    && file !== THIS_FILE
    && file !== TRANSCRIPT_LAB_FIXTURE
    && !file.startsWith("docs/plans/")
    && (TEXT_EXTENSIONS.has(path.extname(file)) || ROOT_TEXT_FILES.has(file)))
}

/** Synchronous: awaiting each of the 8,200 reads took 1.7 s here, one synchronous pass 0.16 s. */
function candidateSources(files: string[]) {
  return files.flatMap((file) => {
    let text: string
    try {
      text = fs.readFileSync(path.join(ROOT, file), "utf8")
    } catch (error) {
      // A file git still lists but the working tree deleted, or a submodule's directory.
      const code = error instanceof Error && "code" in error ? error.code : undefined
      if (code === "ENOENT" || code === "EISDIR") return []
      throw error
    }
    return CANDIDATE.test(text) ? [{ file, text }] : []
  })
}

describe("Agent Extensions hard-cut retirement ratchet", () => {
  test("detects every retired contract family", () => {
    const findings = retiredAgentExtensionFindings([
      { file: "package.json", text: '"@claxedo/agent-extensions": "workspace:*"' },
      { file: "route.ts", text: 'app.get("/api/claxedo/agent-config/extensions")' },
      { file: "runtime.ts", text: "syncAgentExtensions({ agent_extensions: {} })" },
      { file: "store.ts", text: "type AgentExtensionInstall = { id: string }" },
      { file: "ui.ts", text: 'import "@/features/extensions/marketplace"' },
    ])
    expect(new Set(findings.map((finding) => finding.file))).toEqual(
      new Set(["package.json", "route.ts", "runtime.ts", "store.ts", "ui.ts"]),
    )
  })

  test("every retired name is a candidate for the scan", () => {
    for (const pattern of RETIRED) expect(CANDIDATE.test(pattern.source)).toBe(true)
  })

  test("scans every expected repository root and permits no retired production contract", () => {
    const files = scannedFiles()
    for (const root of EXPECTED_ROOTS) expect(files.some((file) => file.startsWith(`${root}/`))).toBe(true)
    expect(files).toContain(".gitignore")
    expect(files).toContain("README.md")
    expect(files.some((file) => file.includes("/.workspace-runtime/"))).toBe(true)

    expect(retiredAgentExtensionFindings(candidateSources(files))).toEqual([])
  })
})
