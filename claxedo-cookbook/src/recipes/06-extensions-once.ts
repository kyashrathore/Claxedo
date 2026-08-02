// WHAT: Author one Agent Extension package on disk (a skill + an MCP server
//       config), install it from the local project directory — no npm, no
//       GitHub — and materialize it for opencode, claude, codex, and cursor
//       in one call via createAgentExtensions().installCached().
// RUN:  bun run recipe:06-extensions-once   (runs: tsx src/recipes/06-extensions-once.ts)
// NEEDS: nothing beyond this repo checkout. No API keys, no agent, no LLM, no network.
// WOW:  1 package -> N files across 4 harness ecosystems: each harness gets
//       the skill + MCP server in ITS native location and format
//       (.opencode/opencode.jsonc, .mcp.json, .codex/config.toml, .cursor/mcp.json).
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAgentExtensions, type HarnessTarget } from "@claxedo/agent-extensions"
import { banner, printResult } from "./_shared"

const TARGETS: HarnessTarget[] = ["opencode", "claude", "codex", "cursor"]

/**
 * SAFETY: everything happens in a fresh temp "project" — the package source,
 * the materialized dotfiles, and the extension cache never touch this repo or
 * your real home directory.
 */
async function makeTempProject() {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "claxedo-extensions-once-"))
  const projectDir = path.join(root, "project")
  const homeDir = path.join(root, "home") // stands in for ~ so nothing global is written
  const dataRoot = path.join(root, "data") // package cache lives here
  await fs.mkdir(projectDir, { recursive: true })
  await fs.mkdir(homeDir, { recursive: true })
  await fs.mkdir(dataRoot, { recursive: true })
  return { root, projectDir, homeDir, dataRoot }
}

/** Author the extension package ONCE: one skill + one MCP server config. */
async function authorPackage(projectDir: string) {
  const packagePath = "extensions/team-kit"
  const packageRoot = path.join(projectDir, packagePath)
  await fs.mkdir(path.join(packageRoot, "mcp"), { recursive: true })
  // A standalone-skill package: SKILL.md at the package root.
  await fs.writeFile(
    path.join(packageRoot, "SKILL.md"),
    [
      "---",
      "name: team-kit",
      "description: Draft release notes from the latest merged changes.",
      "---",
      "",
      "Collect merged PRs since the last tag and draft grouped release notes.",
      "",
    ].join("\n"),
  )
  // Plus one MCP server config in the conventional mcp/ directory.
  await fs.writeFile(
    path.join(packageRoot, "mcp", "team-tools.json"),
    JSON.stringify(
      {
        mcpServers: {
          "team-tools": {
            command: "npx",
            args: ["-y", "@claxedo/mcp"],
            env: { CLAXEDO_SERVER_URL: "http://127.0.0.1:3001" },
          },
        },
      },
      null,
      2,
    ) + "\n",
  )
  return packagePath
}

/** Collect relative paths of every file under dir (descending into symlinked dirs). */
async function walkFiles(root: string, dir = root): Promise<string[]> {
  const out: string[] = []
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name)
    const stat = await fs.stat(full).catch(() => undefined)
    if (stat?.isDirectory()) {
      out.push(...(await walkFiles(root, full)))
    } else if (stat) {
      out.push(path.relative(root, full))
    }
  }
  return out
}

async function main() {
  banner({
    recipe: "06-extensions-once",
    what: "author an Agent Extension package once, install it from a local directory, materialize for 4 harnesses",
    wow: "1 package -> N files across 4 harness ecosystems, each in its native format",
  })

  const { projectDir, homeDir, dataRoot } = await makeTempProject()
  console.log(`temp project: ${projectDir}`)

  // 1. Author the package on disk and show exactly what was written.
  const packagePath = await authorPackage(projectDir)
  printResult(
    `authored package — ${packagePath}/`,
    (await walkFiles(path.join(projectDir, packagePath))).join("\n"),
  )

  // 2. Install from the LOCAL project directory ("project" source): the package
  //    is checksummed, copied to the cache under dataRoot, recorded in
  //    .agent-extensions/{installed,lock}.json, and materialized — one call.
  const extensions = createAgentExtensions({ projectDir, homeDir, dataRoot })
  const installed = await extensions.installCached({
    packagePath,
    id: "team-kit",
    targets: TARGETS,
  })
  printResult("installCached({ packagePath, targets }) — materialized record", {
    id: installed.id,
    packageShape: installed.package.type,
    status: installed.materialized.status,
    targets: installed.materialized.targets,
    components: installed.materialized.components.map((component) => ({
      runner: component.runner,
      component: component.component,
      type: component.type,
      status: component.status,
      path: component.path ? path.relative(projectDir, component.path) : undefined,
    })),
  })

  // 3. The desired/lock/materialized state is queryable any time.
  const snapshot = await extensions.snapshot()
  printResult("snapshot() — runtime desired-state a control plane would push", {
    installs: snapshot.installs.map((install) => ({
      id: install.desired.id,
      source: install.desired.source,
      targets: install.desired.targets,
      enabled: install.effective.enabled,
      status: install.status,
    })),
  })

  // 4. Walk the project: the SAME package landed in each harness's native spot.
  const trees: Record<string, string[]> = {}
  for (const dir of [".opencode", ".claude", ".agents", ".codex", ".cursor", ".agent-extensions"]) {
    const files = await walkFiles(projectDir, path.join(projectDir, dir))
    if (files.length > 0) trees[dir + "/"] = files
  }
  const mcpJson = await fs.stat(path.join(projectDir, ".mcp.json")).catch(() => undefined)
  if (mcpJson) trees[".mcp.json"] = [".mcp.json"]
  printResult("files materialized into the project (relative paths)", trees)

  // 5. Same MCP server, four native formats — the materializer speaks each
  //    harness's config dialect (JSONC, JSON, TOML) so you never have to.
  const read = (rel: string) => fs.readFile(path.join(projectDir, rel), "utf8").then((text) => text.trimEnd())
  printResult("one MCP server, four native formats", {
    "opencode -> .opencode/opencode.jsonc": await read(".opencode/opencode.jsonc"),
    "claude -> .mcp.json": await read(".mcp.json"),
    "codex -> .codex/config.toml": await read(".codex/config.toml"),
    "cursor -> .cursor/mcp.json": await read(".cursor/mcp.json"),
  })

  const applied = installed.materialized.components.filter((component) => component.status === "applied")
  const files = new Set(applied.map((component) => component.path))
  console.log(
    `1 package -> ${files.size} materialized locations (${applied.length} applied components) across ${TARGETS.length} harness ecosystems: ${TARGETS.join(", ")}`,
  )
}

main().catch((err) => {
  console.error(`recipe failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
