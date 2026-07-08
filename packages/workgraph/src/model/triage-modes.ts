import { z } from "zod"
import { readFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { registerLoadout } from "./loadout-registry"
import type { LoadoutResolutionContext } from "./loadout-registry"

const triageModeSchema = z.object({
  promptTemplate: z.string(),
  skillIds: z.array(z.string()),
  decisionAggressiveness: z.enum(["none", "low", "medium", "high"]),
  evidenceThreshold: z.number().min(0).max(1),
  outputBudget: z.number().int().positive(),
})

function prompt(name: string) {
  const filePath = fileURLToPath(new URL(`./triage-modes-prompts/${name}.md`, import.meta.url))
  if (existsSync(filePath)) return readFileSync(filePath, "utf8").trim()
  return ""
}

function selectAuto(ctx: LoadoutResolutionContext) {
  if (ctx.type !== "intake_item" || !ctx.intake) return "normal"
  if (ctx.intake.bodyMd.length > 2_000 || ctx.intake.title?.toLowerCase().includes("spec")) return "deep"
  if (ctx.intake.kind === "external" && ctx.intake.bodyMd.length <= 120) return "light"
  return "normal"
}

registerLoadout("triage_mode", "off", triageModeSchema, {
  promptTemplate: prompt("off"),
  skillIds: [],
  decisionAggressiveness: "none",
  evidenceThreshold: 1,
  outputBudget: 500,
})

registerLoadout("triage_mode", "light", triageModeSchema, {
  promptTemplate: prompt("light"),
  skillIds: [],
  decisionAggressiveness: "low",
  evidenceThreshold: 0.8,
  outputBudget: 2500,
})

registerLoadout("triage_mode", "normal", triageModeSchema, {
  promptTemplate: prompt("normal"),
  skillIds: [],
  decisionAggressiveness: "medium",
  evidenceThreshold: 0.65,
  outputBudget: 6000,
})

registerLoadout("triage_mode", "deep", triageModeSchema, {
  promptTemplate: prompt("deep"),
  skillIds: ["grill-with-docs"],
  decisionAggressiveness: "high",
  evidenceThreshold: 0.5,
  outputBudget: 12000,
})

registerLoadout("triage_mode", "auto", triageModeSchema, {
  promptTemplate: prompt("auto"),
  skillIds: [],
  decisionAggressiveness: "medium",
  evidenceThreshold: 0.65,
  outputBudget: 6000,
}, {
  systemDefault: true,
  selectName: selectAuto,
})
