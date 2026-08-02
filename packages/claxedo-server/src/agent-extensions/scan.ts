import fs from "fs/promises"
import path from "path"

export type DiscoveryState = "discovered" | "adopted" | "generated" | "drifted" | "ignored"

export type DiscoveredAgentExtensionConfig = {
  path: string
  kind:
    | "harness-config-dir"
    | "skills-dir"
    | "instruction-file"
    | "mcp-config"
    | "opencode-config"
  state: DiscoveryState
}

type DiscoveryRecord = {
  path: string
  kind: DiscoveredAgentExtensionConfig["kind"]
  state: Exclude<DiscoveryState, "discovered" | "generated" | "drifted">
  updated_at: number
}

type DiscoveryStateFile = {
  version: 1
  records: DiscoveryRecord[]
}

const candidates: Array<{ path: string; kind: DiscoveredAgentExtensionConfig["kind"]; type: "file" | "dir" }> = [
  { path: ".claude", kind: "harness-config-dir", type: "dir" },
  { path: ".codex", kind: "harness-config-dir", type: "dir" },
  { path: ".cursor", kind: "harness-config-dir", type: "dir" },
  { path: ".opencode", kind: "harness-config-dir", type: "dir" },
  { path: ".agents/skills", kind: "skills-dir", type: "dir" },
  { path: "AGENTS.md", kind: "instruction-file", type: "file" },
  { path: "CLAUDE.md", kind: "instruction-file", type: "file" },
  { path: "opencode.json", kind: "opencode-config", type: "file" },
  { path: "mcp.json", kind: "mcp-config", type: "file" },
  { path: ".vscode/mcp.json", kind: "mcp-config", type: "file" },
]

function discoveryStateFile(root: string) {
  return path.join(root, ".agent-extensions", "discovery.json")
}

function candidate(input: string) {
  return candidates.find((item) => item.path === input)
}

async function matches(root: string, item: (typeof candidates)[number]) {
  const stat = await fs.stat(path.join(root, item.path)).catch(() => null)
  if (!stat) return false
  return item.type === "dir" ? stat.isDirectory() : stat.isFile()
}

async function readDiscoveryState(root: string): Promise<DiscoveryStateFile> {
  const data = await fs.readFile(discoveryStateFile(root), "utf8").then((raw) => JSON.parse(raw) as Partial<DiscoveryStateFile>).catch(() => null)
  return {
    version: 1,
    records: Array.isArray(data?.records)
      ? data.records.flatMap((item) => {
          if (!item || typeof item !== "object") return []
          const row = item as Partial<DiscoveryRecord>
          const found = typeof row.path === "string" ? candidate(row.path) : undefined
          if (!found) return []
          if (row.state !== "adopted" && row.state !== "ignored") return []
          return [{
            path: found.path,
            kind: found.kind,
            state: row.state,
            updated_at: typeof row.updated_at === "number" ? row.updated_at : 0,
          }]
        })
      : [],
  }
}

async function writeDiscoveryState(root: string, state: DiscoveryStateFile) {
  await fs.mkdir(path.dirname(discoveryStateFile(root)), { recursive: true, mode: 0o755 })
  await fs.writeFile(discoveryStateFile(root), JSON.stringify({
    version: 1,
    records: state.records.sort((a, b) => a.path.localeCompare(b.path)),
  }, null, 2) + "\n", { mode: 0o644 })
}

export async function scanExistingAgentExtensionConfig(root: string): Promise<DiscoveredAgentExtensionConfig[]> {
  const state = await readDiscoveryState(root)
  const states = new Map(state.records.map((item) => [item.path, item.state]))
  const rows = await Promise.all(candidates.map(async (item) => ({
    item,
    found: await matches(root, item),
  })))
  return rows
    .filter((row) => row.found)
    .map((row) => ({
      path: row.item.path,
      kind: row.item.kind,
      state: states.get(row.item.path) ?? "discovered" as const,
    }))
}

export async function setDiscoveredAgentExtensionConfigState(input: {
  root: string
  path: string
  state: "adopted" | "ignored"
  now?: number
}) {
  const found = candidate(input.path)
  if (!found) throw new Error("unknown Agent Extension discovery path")
  if (!await matches(input.root, found)) throw new Error("Agent Extension discovery path does not exist")
  const state = await readDiscoveryState(input.root)
  await writeDiscoveryState(input.root, {
    version: 1,
    records: [
      ...state.records.filter((item) => item.path !== found.path),
      {
        path: found.path,
        kind: found.kind,
        state: input.state,
        updated_at: input.now ?? Date.now(),
      },
    ],
  })
  return {
    path: found.path,
    kind: found.kind,
    state: input.state,
  }
}

export async function detachDiscoveredAgentExtensionConfig(input: {
  root: string
  path: string
}) {
  const found = candidate(input.path)
  if (!found) throw new Error("unknown Agent Extension discovery path")
  const state = await readDiscoveryState(input.root)
  await writeDiscoveryState(input.root, {
    version: 1,
    records: state.records.filter((item) => item.path !== found.path),
  })
  return {
    path: found.path,
    kind: found.kind,
    state: "discovered" as const,
  }
}
