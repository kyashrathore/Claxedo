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
  if (id === "launch-empty-home") return baseSeed
  if (id === "launch-project") return { ...baseSeed, sessions: 20, messages: 2_000 }
  if (id === "session-switch") return { ...baseSeed, sessions: 2, messages: 20_000 }
  if (id === "live-terminal-switch") return { ...baseSeed, sessions: 3, terminals: 3, messages: 1_500 }
  if (id === "large-diff-toggle") return { ...baseSeed, changed_files: 500, messages: 500 }
  if (id === "workspace-switch") return { ...baseSeed, projects: 5, sessions: 10, messages: 1_000 }
  return { ...baseSeed, sessions: 1, terminals: 1, changed_files: 120, messages: 10_000 }
}
