import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { AGENT_HARNESS_DEFINITIONS } from "../../../../agent-sdk-runtime/src/harness-types"
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
        .filter((match) => names.has(match[2]!))
        .map((match) => match[1]!)
      ;[...names, ...aliases].forEach((name) => {
        const calls = count(text, new RegExp(`\\b${escape(name)}\\s*\\(`, "g"))
        if (calls > 0) discovered.set(`${file}:${name}`, calls)
      })
    }
    specialSeams().forEach(([key, calls]) => discovered.set(key, calls))
    expect([...discovered.entries()].sort()).toEqual([...classified.entries()].sort())
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
  ]
  const glob = new Bun.Glob("**/*.{ts,tsx,mjs}")
  const files = await Promise.all(
    directories.map(async (directory) =>
      Array.fromAsync(glob.scan({ cwd: join(root, directory), onlyFiles: true })).then((entries) =>
        entries
          .filter((file) => !/\.(test|spec|fixture)\./.test(file) && !file.endsWith("-fixture.mjs"))
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
    match[1]!.split(",").forEach((entry) => {
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
    match[1]!.split(",").forEach((entry) => {
      const parts = entry.trim().split(/\s*:\s*/)
      if (parts[0]) names.add(parts[1] ?? parts[0])
    })
  }
  return names
}

function specialSeams(): Array<readonly [string, number]> {
  return [
    ["packages/workspace-runtime/src/pty/index.ts:ptySpawn", 1],
    ["packages/agent-sdk-runtime/src/harnesses/claude/driver.ts:sdkQuery", 2],
    ["packages/agent-sdk-runtime/src/harnesses/cursor/driver.ts:agentCreate", 2],
    ["packages/agent-sdk-runtime/src/harnesses/pi/index.ts:sessionExec", 1],
    ["packages/agent-sdk-runtime/src/harnesses/pi/model-backend.ts:environmentExec", 1],
  ]
}

function expression(callee: string) {
  if (callee === "ptySpawn") return /\bconst\s+ptyProcess\s*=\s*spawn\s*\(/g
  if (callee === "sdkQuery") return /\bquery\s*\(/g
  if (callee === "agentCreate") return /\bAgent\.create\s*\(/g
  if (callee === "sessionExec") return /\bsession\.env\.exec\s*\(/g
  if (callee === "environmentExec") return /\benv\.exec\s*\(/g
  return new RegExp(`\\b${escape(callee)}\\s*\\(`, "g")
}

function count(text: string, pattern: RegExp) {
  return [...text.matchAll(pattern)].length
}

/**
 * The inventory counts spawn CALLSITES, not textual occurrences. A doc comment
 * that mentions `query()` in prose is not a process spawn, so comments are
 * removed before counting. Absorbing such a mention by bumping a declared
 * `calls` count would be the wrong fix: the count would stop meaning "how many
 * real spawn seams live here" and a genuinely new, unclassified seam could then
 * slip past this gate.
 */
function stripComments(text: string) {
  let out = ""
  let index = 0
  let quote: string | undefined
  while (index < text.length) {
    const char = text[index]!
    if (quote) {
      if (char === "\\") {
        out += char + (text[index + 1] ?? "")
        index += 2
        continue
      }
      if (char === quote) quote = undefined
      out += char
      index += 1
      continue
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char
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
