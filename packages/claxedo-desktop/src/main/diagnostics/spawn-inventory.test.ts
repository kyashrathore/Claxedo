import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { AGENT_HARNESS_DEFINITIONS } from "../../../../agent-runtime-contract/src/harnesses"
import { harnessInventory, SPAWN_INVENTORY } from "./spawn-inventory"

const root = join(import.meta.dirname, "../../../../..")

describe("local production spawn inventory", () => {
  test("classifies every checked process seam exactly once", async () => {
    const sourceRows = SPAWN_INVENTORY.flatMap((row) => (row.source ? [row] : []))
    expect(new Set(SPAWN_INVENTORY.map((row) => row.id)).size).toBe(SPAWN_INVENTORY.length)
    expect(new Set(sourceRows.map((row) => `${row.source!.file}:${row.source!.callee}`)).size).toBe(sourceRows.length)

    for (const row of sourceRows) {
      const text = stripComments(await Bun.file(join(root, row.source!.file)).text())
      expect(count(text, expression(row.source!.callee))).toBe(row.source!.calls)
    }
  })

  test("discovers no unclassified child-process callsite", async () => {
    const classified = new Map(
      SPAWN_INVENTORY.flatMap((row) =>
        row.source ? [[`${row.source.file}:${row.source.callee}`, row.source.calls] as const] : [],
      ),
    )
    const discovered = new Map<string, number>()
    for (const file of await productionFiles()) {
      const text = stripComments(await Bun.file(join(root, file)).text())
      const names = childProcessNames(text)
      const aliases = [
        ...text.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*promisify\(\s*([A-Za-z_$][\w$]*)\s*\)/g),
        // Injectable seam: `const spawnChild = this.input.spawn ?? spawn`.
        //
        // A harness that wants its spawn path testable takes the spawner as an
        // option and defaults to the real one. Without this rule the injected
        // form reads as zero calls, and the inventory silently loses a row —
        // which is exactly what happened when OpenCode's server process gained
        // its seam: the CLI's entry went to 0 while the process still spawned.
        // An inventory that under-counts is worse than none, because its whole
        // claim is that every child this app can start is enumerated here.
        ...text.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*[^\n]*?\?\?\s*([A-Za-z_$][\w$]*)\s*$/gm),
      ]
        .filter((match) => names.has(match[2]))
        .map((match) => match[1])
      ;[...names, ...aliases].forEach((name) => {
        const calls = count(text, new RegExp(`\\b${escape(name)}\\s*\\(`, "g"))
        if (calls > 0) discovered.set(`${file}:${name}`, calls)
      })
    }
    specialSeams(classified).forEach(([key, calls]) => discovered.set(key, calls))
    const byKey = (a: [string, number], b: [string, number]) => a[0].localeCompare(b[0])
    expect([...discovered.entries()].sort(byKey)).toEqual([...classified.entries()].sort(byKey))
  }, 30_000)

  test("derives native, ACP, probe, and MCP scenarios from every harness definition", () => {
    const generated = harnessInventory(AGENT_HARNESS_DEFINITIONS)
    for (const definition of AGENT_HARNESS_DEFINITIONS) {
      expect(
        generated
          .filter((row) => row.key === definition.key)
          .map((row) => row.role)
          .sort(),
      ).toEqual(["harness", "probe", "remote-mcp", "stdio-mcp"])
    }
    expect(new Set(generated.map((row) => row.process)).isSubsetOf(new Set(SPAWN_INVENTORY.map((row) => row.id)))).toBe(
      true,
    )
  })

  test("keeps remote process families excluded and actions independently declared", () => {
    expect(
      SPAWN_INVENTORY.filter((row) => row.classification === "remote-excluded").every(
        (row) => row.observation === "none" && row.stop === "unsupported" && row.kill === "unsupported",
      ),
    ).toBe(true)
    expect(SPAWN_INVENTORY.some((row) => row.stop === "supported" && row.kill === "unsupported")).toBe(true)
  })
})

async function productionFiles() {
  const directories = [
    "packages/claxedo-desktop/src",
    "packages/claxedo-server/src",
    // The two packages the local product was split into. A spawn seam that
    // moves into either must stay audited.
    "packages/claxedo-local-server/src",
    // The shared core the local server composes over. A spawn seam that moves
    // here would otherwise stop being audited without anything saying so.
    "packages/claxedo-server-core/src",
    "packages/workspace-runtime/src",
    "packages/agent-sdk-runtime/src",
    // Electron main reaches this package's credential writer, whose Windows
    // permission step is a spawn. Leaving the package unscanned would let a
    // child the app can start sit outside the inventory this file claims is
    // complete.
    "packages/claxedo-helpers/src",
  ]
  const glob = new Bun.Glob("**/*.{ts,tsx,mjs}")
  const files = await Promise.all(
    directories.map(async (directory) =>
      Array.fromAsync(glob.scan({ cwd: join(root, directory), onlyFiles: true })).then((entries) =>
        entries
          // `[.-]`, so a `.test-support.` helper is excluded like a `.test.` one.
          .filter((file) => !/\.(test|spec|fixture)[.-]/.test(file) && !file.endsWith("-fixture.mjs"))
          // Glob.scan emits host separators; the inventory keys are declared
          // with forward slashes, so normalize or no Windows path ever matches.
          .map((file) => `${directory}/${file.replaceAll("\\", "/")}`),
      ),
    ),
  )
  return files.flat()
}

function childProcessNames(text: string) {
  const names = new Set<string>()
  for (const match of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*["'](?:node:)?child_process["']/g)) {
    match[1].split(",").forEach((entry) => {
      const parts = entry
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)
      if (parts[0] && !parts[0].startsWith("type ")) names.add(parts[1] ?? parts[0])
    })
  }
  for (const match of text.matchAll(
    /\bconst\s*\{([^}]+)\}\s*=\s*(?:await\s+)?(?:import|require)\(\s*["'](?:node:)?child_process["']\s*\)/g,
  )) {
    match[1].split(",").forEach((entry) => {
      const parts = entry.trim().split(/\s*:\s*/)
      if (parts[0]) names.add(parts[1] ?? parts[0])
    })
  }
  return names
}

/**
 * Seams this scanner structurally cannot find: a child spawned inside an SDK
 * (`query()`, `Agent.create()`) or a PTY. There is no
 * `child_process` import to key on, so the KEYS are declared here.
 *
 * The counts are not. They come from the inventory row and are measured against
 * the real file by "classifies every checked process seam exactly once", so
 * this list can never become a second ceiling that drifts away from the first —
 * which is how the Claude turn's move behind an injectable default stayed
 * invisible: both numbers said 2 while the counter could only see 1.
 */
function specialSeams(classified: Map<string, number>): Array<readonly [string, number]> {
  return [
    "packages/workspace-runtime/src/pty/index.ts:ptySpawn",
    "packages/agent-sdk-runtime/src/harnesses/claude/driver.ts:sdkQuery",
    "packages/agent-sdk-runtime/src/harnesses/cursor/driver.ts:agentSpawn",
  ].map((key) => [key, classified.get(key) ?? 0] as const)
}

function expression(callee: string) {
  if (callee === "ptySpawn") return /\bconst\s+ptyProcess\s*=\s*spawn\s*\(/g
  // The Claude turn spawns through an INLINE injectable default —
  // `(this.driverOptions.query ?? query)(...)` — which no bare `query(` match
  // can see. Counting only the direct form leaves the seam that runs on every
  // turn reading as absent while the model probe alone is classified, so the
  // inline default is counted as the callsite it is.
  if (callee === "sdkQuery") return /\bquery\s*\(|\?\?\s*query\s*\)\s*\(/g
  // `Agent.resume` carries the same `local: { cwd }` as `Agent.create` and
  // starts the same CLI, so a seam that stopped creating and only resumed would
  // otherwise read as gone.
  if (callee === "agentSpawn") return /\bAgent\.(?:create|resume)\s*\(/g
  return new RegExp(`\\b${escape(callee)}\\s*\\(`, "g")
}

function count(text: string, pattern: RegExp) {
  return [...text.matchAll(pattern)].length
}

/**
 * The inventory counts spawn CALLSITES, not textual occurrences. A doc comment
 * that mentions `query()` in prose is not a process spawn, and neither is the
 * body of a template literal: `generateAmpPlugin` in workspace-runtime's
 * agent-hooks emits a plugin whose SOURCE imports `spawn` and calls it, and the
 * plugin runs inside Amp, not here. Both are dropped before counting, keeping
 * `${...}` substitutions because a real call can appear in one. Absorbing
 * either by declaring a `calls` count would be the wrong fix: the count would
 * stop meaning "how many real spawn seams live here", and an inventory that
 * invents a child this app cannot start is as false as one that misses a child
 * it can.
 */
function stripComments(text: string) {
  let out = ""
  let index = 0
  let quote: string | undefined
  let templateDepth = 0
  while (index < text.length) {
    const char = text[index]
    if (quote) {
      const emitting = quote !== "`" || templateDepth > 0
      if (char === "\\") {
        if (emitting) out += char + (text[index + 1] ?? "")
        index += 2
        continue
      }
      if (quote === "`" && char === "$" && text[index + 1] === "{") {
        templateDepth += 1
        out += "${"
        index += 2
        continue
      }
      if (quote === "`" && char === "{" && templateDepth > 0) {
        templateDepth += 1
        out += "{"
        index += 1
        continue
      }
      if (quote === "`" && char === "}" && templateDepth > 0) {
        templateDepth -= 1
        out += "}"
        index += 1
        continue
      }
      if (char === quote && templateDepth === 0) {
        quote = undefined
        out += char
        index += 1
        continue
      }
      if (emitting) out += char
      index += 1
      continue
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char
      templateDepth = 0
      out += char
      index += 1
      continue
    }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1
      continue
    }
    if (char === "/" && text[index + 1] === "*") {
      index += 2
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1
      index += 2
      continue
    }
    out += char
    index += 1
  }
  return out
}

function escape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
