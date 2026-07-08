/**
 * Machine-wide discovery of installed skills, plugins, and MCP configs.
 *
 * The project-scoped `scanExistingAgentExtensionConfig` only walks the active
 * repo. Many users have dozens of skills already materialized under their
 * home directory (`~/.claude/skills/`, `~/.codex/skills/`, `~/.cursor/...`,
 * `~/.agents/skills/`) — those need to surface in the Marketplace's
 * "Installed" view even when no project is open.
 *
 * Each entry returned here points at a real file/folder on disk; the
 * Marketplace UI uses these to mark the corresponding catalog rows as
 * already-on-this-machine and to populate a generic discovery list for
 * anything outside the curated catalog.
 */

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export type MachineHarness = "opencode" | "claude" | "codex" | "cursor" | "agents"

export type MachineSkillKind = "skill" | "native-plugin" | "mcp"

export type MachineDiscoveredItem = {
  /** Stable id derived from harness + name; `<harness>-<name>`. */
  id: string
  harness: MachineHarness
  name: string
  kind: MachineSkillKind
  path: string
}

const HOME = os.homedir()

type Probe = {
  harness: MachineHarness
  kind: MachineSkillKind
  /** Directory whose immediate children are skill/plugin folders. */
  root: string
  /** A required marker file inside each child to confirm shape. */
  marker?: string
}

const PROBES: Probe[] = [
  { harness: "claude", kind: "skill", root: path.join(HOME, ".claude", "skills"), marker: "SKILL.md" },
  { harness: "opencode", kind: "skill", root: path.join(HOME, ".config", "opencode", "skills"), marker: "SKILL.md" },
  { harness: "codex", kind: "skill", root: path.join(HOME, ".codex", "skills"), marker: "SKILL.md" },
  { harness: "cursor", kind: "skill", root: path.join(HOME, ".cursor", "skills"), marker: "SKILL.md" },
  { harness: "agents", kind: "skill", root: path.join(HOME, ".agents", "skills"), marker: "SKILL.md" },
  { harness: "cursor", kind: "native-plugin", root: path.join(HOME, ".cursor", "plugins", "local") },
]

function probeFor(harness: MachineHarness, kind: MachineSkillKind): Probe | undefined {
  return PROBES.find((p) => p.harness === harness && p.kind === kind)
}

function safeSegment(name: string): boolean {
  if (!name || name.startsWith(".")) return false
  if (name.includes("/") || name.includes("\\")) return false
  if (name === "." || name === "..") return false
  return true
}

export type DeleteMachineExtensionInput = {
  harness: MachineHarness
  kind: MachineSkillKind
  name: string
}

export async function deleteMachineInstalledExtension(input: DeleteMachineExtensionInput): Promise<{ ok: true; path: string }> {
  if (!safeSegment(input.name)) {
    throw new Error(`Invalid extension name: ${input.name}`)
  }
  const probe = probeFor(input.harness, input.kind)
  if (!probe) {
    throw new Error(`Unknown machine extension probe: ${input.harness}/${input.kind}`)
  }
  const target = path.join(probe.root, input.name)
  // Defense-in-depth: ensure the resolved target is still inside the probe root
  // even after path.join — guards against any trickery slipping past safeSegment.
  const resolvedRoot = path.resolve(probe.root) + path.sep
  const resolvedTarget = path.resolve(target)
  if (!(resolvedTarget + path.sep).startsWith(resolvedRoot)) {
    throw new Error(`Refusing to delete outside probe root: ${resolvedTarget}`)
  }
  const stat = await fs.stat(resolvedTarget).catch(() => null)
  if (!stat) throw new Error(`Not found: ${resolvedTarget}`)
  if (!stat.isDirectory()) throw new Error(`Refusing to delete non-directory: ${resolvedTarget}`)
  await fs.rm(resolvedTarget, { recursive: true, force: true })
  return { ok: true, path: resolvedTarget }
}

async function listChildDirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

async function exists(target: string) {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

export async function scanMachineInstalledExtensions(): Promise<MachineDiscoveredItem[]> {
  const results: MachineDiscoveredItem[] = []
  for (const probe of PROBES) {
    const names = await listChildDirs(probe.root)
    for (const name of names) {
      if (name.startsWith(".")) continue
      const full = path.join(probe.root, name)
      if (probe.marker) {
        const ok = await exists(path.join(full, probe.marker))
        if (!ok) continue
      }
      results.push({
        id: `${probe.harness}-${name}`,
        harness: probe.harness,
        name,
        kind: probe.kind,
        path: full,
      })
    }
  }
  // Stable order: by harness then name so the UI doesn't reshuffle on every
  // call. Avoid `localeCompare` to keep behavior identical across locales.
  results.sort((a, b) => {
    if (a.harness !== b.harness) return a.harness < b.harness ? -1 : 1
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
  return results
}
