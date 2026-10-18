import { describe, expect, test } from "bun:test"
import {
  absorbRunbooks,
  addUpdate,
  declareIncident,
  elapsedSeconds,
  formatDuration,
  postmortemPrompt,
  recordImpact,
  resolve,
  runbookFor,
  runbookProgress,
  stakeholderUpdate,
  transition,
  type DeclareInput,
  type Incident,
} from "./model"

const T0 = new Date(2026, 9, 18, 14, 0, 0).getTime()
const MINUTE = 60_000

const FORM: DeclareInput = {
  title: "Checkout requests failing",
  severity: ["SEV1"],
  services: ["payments", "checkout", "made-up"],
  commander: ["Priya"],
  comms: ["Ana"],
  scribe: ["Lee"],
}

function declared(): Incident {
  const result = declareIncident(FORM, T0)
  if (!result.incident) throw new Error(result.errors.join(" "))
  return result.incident
}

function must(change: { incident: Incident; error?: string }): Incident {
  if (change.error) throw new Error(change.error)
  return change.incident
}

describe("declaring", () => {
  test("a valid form opens an investigating incident with runbooks for known services in catalog order", () => {
    const incident = declared()
    expect(incident.status).toBe("investigating")
    expect(incident.severity).toBe("SEV1")
    expect(incident.services).toEqual(["checkout", "payments"])
    expect(incident.runbooks.map((runbook) => runbook.service)).toEqual(["checkout", "payments"])
    expect(incident.timeline).toEqual([{ at: T0, from: null, to: "investigating", note: "Declared SEV1" }])
  })

  test("every missing field is reported at once", () => {
    const result = declareIncident({ title: "x", severity: [], services: [], commander: [], comms: ["Ana"], scribe: ["Nobody"] }, T0)
    expect(result.incident).toBeNull()
    expect(result.errors).toEqual([
      "Give the incident a title of at least 4 characters.",
      "Pick a severity.",
      "Pick at least one affected service.",
      "Assign an incident commander.",
      "Assign a scribe.",
    ])
  })

  test("the commander cannot also run comms", () => {
    expect(declareIncident({ ...FORM, comms: ["Priya"] }, T0).errors).toContain("The commander and the comms lead should be different people.")
  })
})

describe("status and timeline", () => {
  test("transitions append to the timeline with the previous status and note", () => {
    const identified = must(transition(declared(), "identified", T0 + 5 * MINUTE, " Bad deploy of payments-svc "))
    const monitoring = must(transition(identified, "monitoring", T0 + 9 * MINUTE, ""))
    expect(monitoring.timeline.slice(1)).toEqual([
      { at: T0 + 5 * MINUTE, from: "investigating", to: "identified", note: "Bad deploy of payments-svc" },
      { at: T0 + 9 * MINUTE, from: "identified", to: "monitoring", note: "" },
    ])
  })

  test("a repeated or unknown status is refused without touching the timeline", () => {
    const incident = declared()
    expect(transition(incident, "investigating", T0, "").error).toMatch(/Already investigating/)
    expect(transition(incident, "escalated", T0, "").error).toMatch(/Pick a status/)
    expect(transition(incident, "investigating", T0, "").incident.timeline).toHaveLength(1)
  })

  test("resolving stops the clock and locks the status", () => {
    const resolved = must(resolve(declared(), T0 + 42 * MINUTE + 7000, ""))
    expect(resolved.status).toBe("resolved")
    expect(resolved.timeline.at(-1)?.note).toBe("Resolved")
    expect(elapsedSeconds(resolved, T0 + 5 * 3600_000)).toBe(42 * 60 + 7)
    expect(transition(resolved, "monitoring", T0 + 50 * MINUTE, "").error).toMatch(/resolved/)
  })

  test("elapsed time counts from declaration while open", () => {
    expect(elapsedSeconds(declared(), T0 + 3723_000)).toBe(3723)
    expect(formatDuration(3723)).toBe("01:02:03")
    expect(formatDuration(0)).toBe("00:00:00")
  })
})

describe("runbooks", () => {
  test("absorbing the page's checkboxes updates steps by id", () => {
    const incident = declared()
    const view = [{ steps: [{ id: "checkout-0", done: true }, { id: "checkout-2", done: true }] }, { steps: "garbage" }, null]
    const absorbed = absorbRunbooks(incident, view)
    const checkout = absorbed.runbooks[0]
    if (!checkout) throw new Error("no runbook")
    expect(runbookProgress(checkout)).toEqual({ done: 2, total: 4, percent: 50 })
    expect(absorbRunbooks(incident, "nope")).toBe(incident)
  })

  test("each service has its own steps", () => {
    expect(runbookFor("search").steps.map((step) => step.id)).toEqual(["search-0", "search-1", "search-2"])
  })
})

describe("updates and impact", () => {
  test("an update needs a sentence and records the status it was posted in", () => {
    const incident = declared()
    expect(addUpdate(incident, "short", T0).error).toMatch(/at least a sentence/)
    const updated = must(addUpdate(incident, "  Payments are failing for card checkouts.  ", T0 + MINUTE))
    expect(updated.updates).toEqual([{ id: "update-1", at: T0 + MINUTE, status: "investigating", text: "Payments are failing for card checkouts." }])
  })

  test("impact accepts percentages from the slider and the number field", () => {
    const incident = declared()
    expect(must(recordImpact(incident, 37, "4.256")).impact).toEqual({ usersPercent: 37, errorRate: 4.26 })
    expect(recordImpact(incident, 120, "1").error).toMatch(/0 to 100/)
    expect(recordImpact(incident, 10, "lots").error).toMatch(/Error rate/)
  })

  test("the stakeholder update carries status, duration, impact and the latest update", () => {
    const incident = must(recordImpact(must(addUpdate(declared(), "Rolled back payments-svc to 2.3.1.", T0 + 10 * MINUTE)), 12, "3"))
    const markdown = stakeholderUpdate(incident, T0 + 15 * MINUTE)
    expect(markdown).toContain("### SEV1 · Checkout requests failing")
    expect(markdown).toContain("**Status:** Investigating · **Duration:** 00:15:00")
    expect(markdown).toContain("12% of users affected, 3% error rate")
    expect(markdown).toContain("Rolled back payments-svc to 2.3.1.")
    expect(markdown).toMatch(/Next update by \d\d:\d\d/)
    expect(stakeholderUpdate(must(resolve(incident, T0 + 20 * MINUTE, "")), T0 + 30 * MINUTE)).toContain("a postmortem will follow")
  })
})

test("the postmortem prompt is structured from the incident data", () => {
  const worked = absorbRunbooks(declared(), [{ steps: [{ id: "checkout-1", done: true }] }])
  const incident = must(resolve(must(transition(worked, "identified", T0 + 5 * MINUTE, "Bad deploy")), T0 + 30 * MINUTE, "Rolled back"))
  const prompt = postmortemPrompt(incident, T0 + 60 * MINUTE)
  expect(prompt).toContain('blameless postmortem for the incident "Checkout requests failing"')
  expect(prompt).toContain("- Severity: SEV1 (critical, customer-facing outage)")
  expect(prompt).toContain("- Duration: 00:30:00")
  expect(prompt).toContain("Investigating → Identified: Bad deploy")
  expect(prompt).toContain("- [x] checkout: Check the payment and inventory dependency health")
  expect(prompt).toContain("- [ ] payments: Pause retries if the processor is degraded")
  expect(prompt).toContain("- none posted")
})
