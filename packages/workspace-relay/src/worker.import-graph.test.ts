import path from "node:path"
import { describe, expect, test } from "bun:test"

const SRC = path.resolve(import.meta.dirname)
const ENTRYPOINTS = ["worker.ts"]

const FORBIDDEN_BARE = [
  "@hono/node-server",
  "@hono/node-ws",
  "better-sqlite3",
  "node:child_process",
  "node:crypto",
  "node:fs",
  "node:net",
  "node:path",
  "node:url",
  "fs",
  "fs/promises",
]

const FORBIDDEN_LOCAL = [
  "bun.ts",
  "main.ts",
  "synthetic.ts",
]

type ImportRef = { spec: string; typeOnly: boolean }

function parseImports(source: string): ImportRef[] {
  const refs: ImportRef[] = []
  const fromRe = /(?:^|\n)\s*(import|export)\s+(type\s+)?[\s\S]*?\sfrom\s+["']([^"']+)["']/g
  for (let m = fromRe.exec(source); m; m = fromRe.exec(source)) {
    refs.push({ spec: m[3]!, typeOnly: !!m[2] })
  }
  const sideRe = /(?:^|\n)\s*import\s+["']([^"']+)["']/g
  for (let m = sideRe.exec(source); m; m = sideRe.exec(source)) {
    refs.push({ spec: m[1]!, typeOnly: false })
  }
  const dynRe = /import\(\s*["']([^"']+)["']\s*\)/g
  for (let m = dynRe.exec(source); m; m = dynRe.exec(source)) {
    refs.push({ spec: m[1]!, typeOnly: false })
  }
  return refs
}

async function resolveRelative(fromFile: string, spec: string) {
  const base = path.resolve(path.dirname(fromFile), spec)
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]
  return await Promise.all(candidates.map(async (candidate) => ({
    candidate,
    exists: await Bun.file(candidate).exists(),
  }))).then((items) => items.find((item) => item.exists)?.candidate)
}

async function walk() {
  const visited = new Set<string>()
  const bareImports: Array<{ from: string; spec: string }> = []
  const queue = ENTRYPOINTS.map((entrypoint) => path.join(SRC, entrypoint))

  while (queue.length) {
    const file = queue.shift()!
    if (visited.has(file)) continue
    visited.add(file)
    const source = await Bun.file(file).text()
    for (const ref of parseImports(source)) {
      if (ref.typeOnly) continue
      if (ref.spec.startsWith(".") || ref.spec.startsWith("/")) {
        const resolved = await resolveRelative(file, ref.spec)
        if (resolved && !visited.has(resolved)) queue.push(resolved)
      } else {
        bareImports.push({ from: path.relative(SRC, file), spec: ref.spec })
      }
    }
  }
  return { visited, bareImports }
}

const { visited, bareImports } = await walk()
const visitedRel = [...visited].map((file) => path.relative(SRC, file))

describe("workspace relay Worker import graph", () => {
  test("entrypoint and Worker-safe relay room are reachable", () => {
    expect(visitedRel).toContain("worker.ts")
    expect(visitedRel).toContain("cloudflare.ts")
    expect(visitedRel).toContain("server.ts")
  })

  test("does not import local Bun entrypoints or synthetic probes", () => {
    const leaked = visitedRel.filter((rel) => FORBIDDEN_LOCAL.some((bad) => rel.endsWith(bad)))
    expect(leaked, `local-only relay modules leaked into the Worker graph: ${leaked.join(", ")}`).toEqual([])
  })

  test("does not import Node-only packages", () => {
    const leaked = bareImports.filter((item) => FORBIDDEN_BARE.includes(item.spec))
    const detail = leaked.map((item) => `${item.spec} (from ${item.from})`).join(", ")
    expect(leaked, `forbidden bare imports in the relay Worker graph: ${detail}`).toEqual([])
  })
})
