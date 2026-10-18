import { describe, expect, test } from "bun:test"
import {
  batchTitles,
  clampBatch,
  fillTemplate,
  launchRow,
  placeholders,
  projectsSignature,
  readLaunchForm,
  refreshStatuses,
  launchStats,
  launcherStatus,
  templateById,
  validateLaunch,
  variablesFor,
  type Launch,
} from "./model"

const projects = [
  { id: "p1", name: "Claxedo" },
  { id: "p2", name: "Docs site" },
]

function launch(overrides: Partial<Launch>): Launch {
  return { key: "k", title: "Task", projectName: "Claxedo", launchedAt: "10:00:00", status: "running", ...overrides }
}

describe("templates", () => {
  test("lists placeholders once each, in order", () => {
    expect(placeholders("Refactor {module} so {goal}; keep {module} stable")).toEqual(["module", "goal"])
    expect(placeholders("no braces, {} or {1bad}")).toEqual([])
  })

  test("fills known variables and leaves blank ones as placeholders", () => {
    const filled = fillTemplate("Refactor {module} so that {goal}.", [
      { name: "module", label: "Module", value: " src/router.ts " },
      { name: "goal", label: "Goal", value: "  " },
    ])
    expect(filled).toBe("Refactor src/router.ts so that {goal}.")
  })

  test("keeps the values a person typed when switching to a template sharing a variable", () => {
    const docs = variablesFor(templateById("write-docs"), [{ name: "module", label: "Module", value: "auth" }])
    expect(docs).toEqual([
      { name: "module", label: "Module", value: "auth" },
      { name: "audience", label: "Audience", value: "" },
    ])
    expect(variablesFor(templateById("review-diff"), docs)).toEqual([{ name: "base", label: "Base branch", value: "" }])
  })

  test("falls back to the custom template for an unknown id", () => {
    expect(templateById("nope").id).toBe("custom")
  })
})

describe("batches", () => {
  test("reads the parallel-sessions picker as 1..5 whole sessions", () => {
    expect(clampBatch(["3"])).toBe(3)
    expect(clampBatch(["0"])).toBe(1)
    expect(clampBatch(["9"])).toBe(5)
    expect(clampBatch([])).toBe(1)
    expect(clampBatch(3)).toBe(1)
  })

  test("numbers titles only for more than one session and falls back to the template name", () => {
    expect(batchTitles("Fix auth", 1, "Fix failing tests")).toEqual(["Fix auth"])
    expect(batchTitles("  ", 3, "Review diff")).toEqual(["Review diff #1", "Review diff #2", "Review diff #3"])
  })
})

describe("launch validation", () => {
  const base = { templateId: "refactor", projectId: "p1", prompt: "Refactor x so that y.", title: "", batch: 1, variables: [] }

  test("accepts a complete form", () => {
    expect(validateLaunch(base, projects)).toEqual([])
  })

  test("reports an unknown project, an empty prompt and unfilled template variables", () => {
    expect(validateLaunch({ ...base, projectId: "gone", prompt: "  " }, projects)).toEqual(["Choose a project.", "Write a prompt."])
    expect(validateLaunch({ ...base, prompt: "Refactor {module} so that {goal}." }, projects)).toEqual(["Fill in {module}, {goal}."])
  })

  test("ignores braces that are not the template's variables", () => {
    expect(validateLaunch({ ...base, templateId: "custom", prompt: "Print {name} in the greeting" }, projects)).toEqual([])
  })

  test("reads the form from an action context, taking the picker's first value", () => {
    const form = readLaunchForm({
      template: "write-docs",
      project: ["p2"],
      prompt: "Document it",
      title: "Docs",
      batch: ["7"],
      variables: [{ name: "module", label: "Module", value: "auth" }, "junk"],
    })
    expect(form).toEqual({
      templateId: "write-docs",
      projectId: "p2",
      prompt: "Document it",
      title: "Docs",
      batch: 5,
      variables: [{ name: "module", label: "Module", value: "auth" }],
    })
    expect(readLaunchForm({}).projectId).toBe("")
  })
})

describe("launched sessions", () => {
  test("refreshes only sessions with a ref and reports the indexes that changed", () => {
    const ref = { sessionId: "s1", workspaceId: "w1" }
    const launches = [launch({ status: "launching" }), launch({ ref, status: "running" }), launch({ ref: { sessionId: "s2", workspaceId: "w1" }, status: "idle" })]
    const refreshed = refreshStatuses(launches, (key) => (key.sessionId === "s1" ? "waiting" : "idle"))
    expect(refreshed.changed).toEqual([1])
    expect(refreshed.launches[1]!.status).toBe("waiting")
    expect(refreshed.launches[2]).toBe(launches[2]!)
  })

  test("counts launched, active, waiting and failed sessions as stat values", () => {
    const launches = [launch({ status: "waiting" }), launch({ status: "running" }), launch({ status: "running_in_background" }), launch({ status: "launch_failed" }), launch({ status: "failed" })]
    expect(launchStats(launches)).toEqual({ launched: "5", active: "2", attention: "1", failed: "2" })
    expect(launchStats([])).toEqual({ launched: "0", active: "0", attention: "0", failed: "0" })
  })

  test("names the page status in words with a tone, input requests first", () => {
    expect(launcherStatus([launch({ status: "running" })], true)).toEqual({ text: "Launching", tone: "accent" })
    expect(launcherStatus([launch({ status: "waiting" }), launch({ status: "waiting" }), launch({ status: "running" })], false)).toEqual({ text: "2 need input", tone: "warning" })
    expect(launcherStatus([launch({ status: "waiting" })], false)).toEqual({ text: "1 needs input", tone: "warning" })
    expect(launcherStatus([launch({ status: "running" }), launch({ status: "idle" })], false)).toEqual({ text: "1 running", tone: "success" })
    expect(launcherStatus([launch({ status: "idle" })], false)).toEqual({ text: "All settled", tone: "neutral" })
    expect(launcherStatus([], false)).toEqual({ text: "Nothing launched", tone: "neutral" })
  })

  test("shows a failed launch's error beside its project", () => {
    expect(launchRow(launch({ status: "launch_failed", error: "no placement" }))).toEqual({
      key: "k",
      title: "Task",
      status: "Launch failed",
      tone: "danger",
      detail: "Claxedo · 10:00:00 · no placement",
    })
  })

  test("detects a renamed or added project", () => {
    expect(projectsSignature(projects)).toBe(projectsSignature([...projects]))
    expect(projectsSignature(projects)).not.toBe(projectsSignature([{ id: "p1", name: "Renamed" }, projects[1]!]))
  })
})
