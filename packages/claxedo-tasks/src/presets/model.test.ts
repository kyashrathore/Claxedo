import { describe, expect, test } from "bun:test"
import { TASKS_BOUNDS, type PluginReference, type SkillReference } from "../contracts"
import { HARNESSES } from "../test-support/fakes"
import { presetDraft, primaryConfiguration } from "../test-support/rows"
import { validatePresetDraft, type HarnessLookup } from "./model"

const harness: HarnessLookup = (reference) =>
  HARNESSES.find((entry) => entry.id === reference.id && entry.access === reference.access)

function reasons(result: ReturnType<typeof validatePresetDraft>): Record<string, string> {
  if (result.ok) return {}
  return Object.fromEntries(result.fields.map((field) => [field.path, field.reason]))
}

function plugins(count: number): PluginReference[] {
  return Array.from({ length: count }, (_, index) => ({ sourceId: "claxedo", pluginName: `plugin-${index}` }))
}

function skills(count: number): SkillReference[] {
  return Array.from({ length: count }, (_, index) => ({ sourceId: "claxedo", skillName: `skill-${index}` }))
}

describe("validatePresetDraft", () => {
  test("accepts a local draft with only a primary configuration", () => {
    expect(validatePresetDraft(presetDraft(), harness).ok).toBe(true)
  })

  test("names an empty and an over-long name", () => {
    expect(reasons(validatePresetDraft(presetDraft({ name: "   " }), harness))).toEqual({ name: "required" })
    const long = "n".repeat(TASKS_BOUNDS.presetNameMax + 1)
    expect(reasons(validatePresetDraft(presetDraft({ name: long }), harness))).toEqual({ name: "too_long" })
  })

  test("measures instructions in bytes, not characters", () => {
    const justUnder = "é".repeat(TASKS_BOUNDS.instructionsMaxBytes / 2)
    expect(validatePresetDraft(presetDraft({ instructions: justUnder }), harness).ok).toBe(true)
    const over = "é".repeat(TASKS_BOUNDS.instructionsMaxBytes / 2 + 1)
    expect(reasons(validatePresetDraft(presetDraft({ instructions: over }), harness))).toEqual({ instructions: "too_long" })
  })

  test("bounds cloud selections and refuses duplicate identities", () => {
    const tooManyPlugins = presetDraft({
      execution: {
        placement: "cloud",
        capabilities: { mode: "selected", plugins: plugins(TASKS_BOUNDS.pluginReferencesMax + 1), skills: [] },
      },
    })
    expect(reasons(validatePresetDraft(tooManyPlugins, harness))["execution.capabilities.plugins"]).toBe("too_many")

    const tooManySkills = presetDraft({
      execution: {
        placement: "cloud",
        capabilities: { mode: "selected", plugins: [], skills: skills(TASKS_BOUNDS.skillReferencesMax + 1) },
      },
    })
    expect(reasons(validatePresetDraft(tooManySkills, harness))["execution.capabilities.skills"]).toBe("too_many")

    const duplicated = presetDraft({
      execution: {
        placement: "cloud",
        capabilities: {
          mode: "selected",
          plugins: [
            { sourceId: "claxedo", pluginName: "review" },
            { sourceId: "claxedo", pluginName: "review" },
          ],
          skills: [
            { sourceId: "claxedo", skillName: "writing" },
            { sourceId: "claxedo", skillName: "writing" },
          ],
        },
      },
    })
    expect(reasons(validatePresetDraft(duplicated, harness))).toEqual({
      "execution.capabilities.plugins[1]": "duplicate",
      "execution.capabilities.skills[1]": "duplicate",
    })
  })

  test("accepts the same name from two sources as two identities", () => {
    const draft = presetDraft({
      execution: {
        placement: "cloud",
        capabilities: {
          mode: "selected",
          plugins: [
            { sourceId: "claxedo", pluginName: "review" },
            { sourceId: "personal", pluginName: "review" },
          ],
          skills: [],
        },
      },
    })
    expect(validatePresetDraft(draft, harness).ok).toBe(true)
  })

  test("an empty cloud selection is a valid selection, not an absent one", () => {
    const draft = presetDraft({
      execution: { placement: "cloud", capabilities: { mode: "selected", plugins: [], skills: [] } },
    })
    const result = validatePresetDraft(draft, harness)
    expect(result.ok).toBe(true)
    expect(result.ok && result.value.execution.capabilities).toEqual({ mode: "selected", plugins: [], skills: [] })
  })

  test("an unknown harness and a mismatched access kind are both unknown values", () => {
    const unknown = presetDraft({
      configurations: { primary: primaryConfiguration({ harness: { id: "nonesuch", access: "native" } }) },
    })
    expect(reasons(validatePresetDraft(unknown, harness))).toEqual({ "configurations.primary.harness": "unknown_value" })

    const wrongAccess = presetDraft({
      configurations: { primary: primaryConfiguration({ harness: { id: "claude", access: "connection" } }) },
    })
    expect(reasons(validatePresetDraft(wrongAccess, harness))).toEqual({ "configurations.primary.harness": "unknown_value" })
  })

  test("an effort the harness never advertised is refused rather than dropped", () => {
    const draft = presetDraft({ configurations: { primary: primaryConfiguration({ effort: "extreme" }) } })
    const result = validatePresetDraft(draft, harness)
    expect(reasons(result)).toEqual({ "configurations.primary.effort": "unknown_value" })

    const noEfforts = presetDraft({
      configurations: {
        primary: primaryConfiguration({ harness: { id: "codex", access: "native" }, effort: "high" }),
      },
    })
    expect(reasons(validatePresetDraft(noEfforts, harness))).toEqual({ "configurations.primary.effort": "unknown_value" })
  })

  test("null effort is accepted for every harness", () => {
    const draft = presetDraft({
      configurations: {
        primary: primaryConfiguration({ harness: { id: "codex", access: "native" }, effort: null }),
      },
    })
    expect(validatePresetDraft(draft, harness).ok).toBe(true)
  })

  test("validates every optional slot, not only the primary one", () => {
    const draft = presetDraft({
      configurations: {
        primary: primaryConfiguration(),
        planning: primaryConfiguration({ effort: "high" }),
        review: primaryConfiguration({ harness: { id: "nonesuch", access: "native" } }),
      },
    })
    expect(reasons(validatePresetDraft(draft, harness))).toEqual({ "configurations.review.harness": "unknown_value" })
  })
})
