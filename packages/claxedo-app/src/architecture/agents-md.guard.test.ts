import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { logicalOwner } from "./ownership"
import { importSpecifiers } from "./import-graph"
import { walk } from "./scanners"
import writers from "./query-cache-writers.json"

type AgentsContract = {
  owns: string
  writerOf: string[]
  mustNotImport: string[]
}

const appRoot = path.resolve(import.meta.dir, "../..")
const srcRoot = path.join(appRoot, "src")
const legacyRequiredDirs: string[] = []
const finalOwnerDirs = [...new Set(
  walk(srcRoot)
    .map((file) => path.relative(srcRoot, file).split(path.sep).join("/"))
    .flatMap((file) => {
      const owner = logicalOwner(file)
      if (!owner || owner === "architecture" || owner.startsWith("legacy/")) return []
      return [owner]
    }),
)].sort()
const requiredDirs = [...legacyRequiredDirs, ...finalOwnerDirs]
const writerFamilies = new Set((writers as { families: Array<{ family: string }> }).families.map((family) => family.family))

describe("per-directory AGENTS.md contracts", () => {
  test("required layer directories have parseable contracts", () => {
    const offenders = requiredDirs.flatMap((dir) => {
      const file = path.join(srcRoot, dir, "AGENTS.md")
      const contract = readContract(file)
      if (typeof contract === "string") return [`${dir}/AGENTS.md: ${contract}`]
      if (!contract.owns) return [`${dir}/AGENTS.md: owns must be non-empty`]
      return []
    })

    expect(offenders).toEqual([])
  })

  test("must-not-import contracts match real imports", () => {
    const offenders = requiredDirs.flatMap((dir) => {
      const contract = readContract(path.join(srcRoot, dir, "AGENTS.md"))
      if (typeof contract === "string") return [`${dir}/AGENTS.md: ${contract}`]

      return prodFiles(path.join(srcRoot, dir)).flatMap((file) => {
        const text = readFileSync(file, "utf8")
        return importSpecifiers(text).flatMap((specifier) => {
          const forbidden = contract.mustNotImport.find((glob) => matchesGlob(specifier, glob))
          if (!forbidden) return []
          return [`${path.relative(srcRoot, file)} imports ${specifier}, forbidden by ${dir}/AGENTS.md (${forbidden})`]
        })
      })
    })

    expect(offenders).toEqual([])
  })

  test("writerOf entries correspond to query-cache-writers.json families", () => {
    const offenders = requiredDirs.flatMap((dir) => {
      const contract = readContract(path.join(srcRoot, dir, "AGENTS.md"))
      if (typeof contract === "string") return [`${dir}/AGENTS.md: ${contract}`]
      return contract.writerOf
        .filter((family) => !writerFamilies.has(family))
        .map((family) => `${dir}/AGENTS.md claims writerOf ${family}, but query-cache-writers.json has no such family`)
    })

    expect(offenders).toEqual([])
  })
})

function readContract(file: string): AgentsContract | string {
  const text = readFileSync(file, "utf8")
  const match = text.match(/```json\s*([\s\S]*?)```/)
  if (!match) return "missing fenced json contract"
  try {
    const parsed = JSON.parse(match[1]) as Partial<AgentsContract>
    return {
      owns: String(parsed.owns ?? ""),
      writerOf: Array.isArray(parsed.writerOf) ? parsed.writerOf.map(String) : [],
      mustNotImport: Array.isArray(parsed.mustNotImport) ? parsed.mustNotImport.map(String) : [],
    }
  } catch (error) {
    return `invalid json contract: ${error instanceof Error ? error.message : String(error)}`
  }
}

function prodFiles(dir: string) {
  return walk(dir)
    .filter((file) => /\.(ts|tsx)$/.test(file))
    .filter((file) => !/\.(test|vitest)\./.test(file))
    .filter((file) => !file.endsWith(".d.ts"))
}

function matchesGlob(value: string, glob: string) {
  const pattern = new RegExp(`^${glob.split("*").map(escapeRegExp).join(".*")}$`)
  return pattern.test(value)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
