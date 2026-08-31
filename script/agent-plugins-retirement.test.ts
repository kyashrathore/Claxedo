import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")
const THIS_FILE = "script/agent-plugins-retirement.test.ts"
const EXPECTED_ROOTS = [".github", "convex", "packages", "script", "public-docs"] as const
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
    return [...text.matchAll(new RegExp(pattern.source, flags))].map((match) => ({ file, token: match[0]! }))
  }))
}

async function repositorySources() {
  const files: Array<{ file: string; text: string }> = []
  const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf8",
  })
  for (const file of listed.split("\n").filter(Boolean)) {
    if (file === THIS_FILE
      || file.startsWith("docs/plans/")
      || (!TEXT_EXTENSIONS.has(path.extname(file)) && !ROOT_TEXT_FILES.has(file))) continue
    const absolute = path.join(ROOT, file)
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue
    files.push({ file, text: await Bun.file(absolute).text() })
  }
  return files
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

  test("scans every expected repository root and permits no retired production contract", async () => {
    const sources = await repositorySources()
    for (const root of EXPECTED_ROOTS) expect(sources.some((source) => source.file.startsWith(`${root}/`))).toBe(true)
    expect(sources.some((source) => source.file === ".gitignore")).toBe(true)
    expect(sources.some((source) => source.file === "README.md")).toBe(true)
    expect(sources.some((source) => source.file.includes("/.workspace-runtime/"))).toBe(true)

    const findings = retiredAgentExtensionFindings(sources)
    expect(findings).toEqual([])
  })
})
