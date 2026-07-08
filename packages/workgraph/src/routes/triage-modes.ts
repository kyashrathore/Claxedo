import { Hono } from "hono"
import "../model/triage-modes"
import { listLoadoutRegistryEntries } from "../model/loadout-registry"

const descriptions: Record<string, string> = {
  off: "Capture only. Do not run triage.",
  light: "Quick triage for small, clear intake.",
  normal: "Default triage for ordinary product and engineering intake.",
  deep: "Expanded triage for broad specs or ambiguous work.",
  auto: "Selects the best built-in mode from intake shape.",
}

export function triageModesRouter() {
  const router = new Hono()

  router.get("/triage-modes", (c) => c.json({
    modes: listLoadoutRegistryEntries("triage_mode")
      .map((entry) => ({
        name: entry.name,
        description: typeof entry.defaults.description === "string"
          ? entry.defaults.description
          : descriptions[entry.name] ?? entry.name,
        defaults: safeDefaults(entry.defaults),
        requiresExplicitOverride: entry.defaults.requiresExplicitOverride === true,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }))

  return router
}

function safeDefaults(defaults: Record<string, unknown>) {
  const { promptTemplate: _, skillIds: __, description: ___, requiresExplicitOverride: ____, ...safe } = defaults
  return safe
}
