import type { ScenarioId, SeedManifest } from "./types"

const baseSeed = {
  repos: 1,
  sessions: 0,
  messages: 0,
  terminals: 0,
  changed_files: 0,
  projects: 1,
  themes: ["claxedo-dark"],
  agent_actions: 0,
  mask_keys: ["timestamp", "random_id", "absolute_path"],
} satisfies SeedManifest

export function seedForScenario(id: ScenarioId): SeedManifest {
  return diagnosticOverrides(defaultSeedForScenario(id))
}

function defaultSeedForScenario(id: ScenarioId): SeedManifest {
  if (id === "launch-project") return { ...baseSeed, sessions: 20, messages: 2_000 }
  if (id === "session-switch") return { ...baseSeed, sessions: 2, messages: 20_000 }
  if (id === "live-terminal-switch") return { ...baseSeed, sessions: 3, terminals: 3, messages: 1_500 }
  if (id === "large-diff-toggle") return { ...baseSeed, changed_files: 500, messages: 500 }
  if (id === "heavy-workspace-reopen" || id === "heavy-workspace-review-resume" || id === "heavy-workspace-close") {
    return { ...baseSeed, sessions: 3, terminals: 3, changed_files: 500, messages: 1_500 }
  }
  if (id === "workspace-switch") return { ...baseSeed, projects: 5, sessions: 10, messages: 1_000 }
  return { ...baseSeed, sessions: 1, terminals: 1, changed_files: 120, messages: 10_000 }
}

function diagnosticOverrides(seed: SeedManifest): SeedManifest {
  if (process.env.CLAXEDO_PERF_DIAGNOSTIC !== "1") return seed
  return {
    ...seed,
    sessions: diagnosticCount("CLAXEDO_PERF_SEED_SESSIONS") ?? seed.sessions,
    messages: diagnosticCount("CLAXEDO_PERF_SEED_MESSAGES") ?? seed.messages,
    terminals: diagnosticCount("CLAXEDO_PERF_SEED_TERMINALS") ?? seed.terminals,
    changed_files: diagnosticCount("CLAXEDO_PERF_SEED_CHANGED_FILES") ?? seed.changed_files,
    projects: diagnosticCount("CLAXEDO_PERF_SEED_PROJECTS") ?? seed.projects,
  }
}

function diagnosticCount(name: string) {
  const value = Number(process.env[name])
  if (!Number.isInteger(value) || value < 0) return undefined
  return value
}
