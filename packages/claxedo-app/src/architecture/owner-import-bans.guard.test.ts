import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { importSpecifiers } from "./import-graph"
import { prodSourcePaths } from "./scanners"

/**
 * Import bans narrower than the owner graph.
 *
 * `ownership.ts` decides which owners may depend on which. It cannot say that
 * an owner must stay free of a framework, or that a platform capability may not
 * reach a sibling capability it would otherwise be allowed to import.
 */
const IMPORT_BANS: Record<string, { reason: string; specifiers: string[] }> = {
  "platform/identity": {
    reason:
      "Session identity vocabulary, route parsing and workspace-ref resolution stay pure: transport, SDK, UI, auth and Solid runtime decisions belong to their callers.",
    specifiers: ["solid-js", "solid-js/*", "@tanstack/*", "@opencode-ai/sdk*", "../auth/*"],
  },
  "platform/performance": {
    reason: "Any module must be able to measure a phase without widening its own import graph.",
    specifiers: ["solid-js", "solid-js/*", "@tanstack/*", "@opencode-ai/sdk*"],
  },
}

const appRoot = path.resolve(import.meta.dir, "../..")
const srcRoot = path.join(appRoot, "src")

function violations(owner: string, files: { file: string; text: string }[]) {
  const { specifiers } = IMPORT_BANS[owner]
  return files.flatMap(({ file, text }) =>
    importSpecifiers(text).flatMap((specifier) => {
      const banned = specifiers.find((glob) => matchesGlob(specifier, glob))
      return banned ? [`${file} imports ${specifier} (${owner} bans ${banned})`] : []
    }),
  )
}

function matchesGlob(value: string, glob: string) {
  return new RegExp(`^${glob.split("*").map(escapeRegExp).join(".*")}$`).test(value)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

describe("owner import bans", () => {
  test.each(Object.keys(IMPORT_BANS))("%s imports nothing it bans", (owner) => {
    const dir = path.join(srcRoot, owner)
    const files = prodSourcePaths(appRoot)
      .filter((file) => file.startsWith(`${dir}${path.sep}`))
      .map((file) => ({ file: path.relative(srcRoot, file), text: readFileSync(file, "utf8") }))

    expect(files.length).toBeGreaterThan(0)
    expect(violations(owner, files)).toEqual([])
  })

  test("detects a banned framework import", () => {
    const planted = [{ file: "platform/performance/planted.ts", text: `import { createStore } from "solid-js/store"\n` }]
    expect(violations("platform/performance", planted)).toEqual([
      "platform/performance/planted.ts imports solid-js/store (platform/performance bans solid-js/*)",
    ])
  })
})
