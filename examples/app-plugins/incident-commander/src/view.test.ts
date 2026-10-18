import { describe, expect, test } from "bun:test"
import { addUpdate, declareIncident, recordImpact, transition, type Incident } from "./model"
import { incidentComponents, noticeMessages, summaryData, timelineData, updatesData } from "./view"

const T0 = new Date(2026, 9, 18, 14, 0, 0).getTime()

function declared(): Incident {
  const result = declareIncident({ title: "Checkout requests failing", severity: ["SEV1"], services: ["checkout"], commander: ["Priya"], comms: ["Ana"], scribe: ["Lee"] }, T0)
  if (!result.incident) throw new Error(result.errors.join(" "))
  return result.incident
}

function must(change: { incident: Incident; error?: string }): Incident {
  if (change.error) throw new Error(change.error)
  return change.incident
}

describe("summary", () => {
  test("no incident reads all clear with placeholder figures", () => {
    expect(summaryData(null)).toMatchObject({ status: "All clear", statusTone: "success", users: { value: "—", caption: "No open incident" } })
  })

  test("an open incident carries severity and status tones and unit-bearing figures", () => {
    const incident = must(addUpdate(must(recordImpact(declared(), 30, "2.5")), "Rolled back the payments deploy.", T0 + 5 * 60_000))
    expect(summaryData(incident)).toMatchObject({
      severity: "SEV1",
      severityTone: "danger",
      status: "Investigating",
      statusTone: "danger",
      subtitle: "Commander Priya · Comms Ana · Scribe Lee",
      declared: "Declared at 14:00:00",
      users: { value: "30%" },
      errors: { value: "2.5%", caption: "Requests to checkout" },
      updates: { value: "1", caption: "Last posted at 14:05:00" },
    })
  })
})

describe("rows", () => {
  test("timeline rows name the change, the time with the note and the offset from declaring", () => {
    const incident = must(transition(declared(), "identified", T0 + 65_000, "Bad deploy"))
    expect(timelineData(incident)).toEqual([
      { time: "14:00:00", elapsed: "T+00:00:00", change: "Declared · Investigating", note: "Declared SEV1", detail: "14:00:00 · Declared SEV1" },
      { time: "14:01:05", elapsed: "T+00:01:05", change: "Investigating → Identified", note: "Bad deploy", detail: "14:01:05 · Bad deploy" },
    ])
  })

  test("updates list newest first with the status they were posted in as a toned badge", () => {
    const first = must(addUpdate(declared(), "Payments are failing for cards.", T0))
    const second = must(addUpdate(must(transition(first, "monitoring", T0, "")), "Error rate is back to normal.", T0 + 60_000))
    expect(updatesData(second).map((update) => [update.status, update.tone])).toEqual([
      ["Monitoring", "accent"],
      ["Investigating", "danger"],
    ])
  })
})

describe("structure", () => {
  test("idle shows the declare form and an active incident the response view", () => {
    const root = (incident: Incident | null) => incidentComponents(incident).find((component) => component.id === "root")
    expect(root(null)).toMatchObject({ children: ["header", "declare-section"] })
    expect(root(declared())).toMatchObject({ children: ["header", "kpis", "status", "response", "postmortem-section"] })
  })

  test("a notice adds its callout above the host's footer once and clears with the host alone", () => {
    const shown = noticeMessages("s", "status", { title: "Status not changed", text: "Already identified." }, false)
    const added = shown[1]
    if (!added || !("updateComponents" in added)) throw new Error("expected components")
    expect(added.updateComponents.components[0]).toMatchObject({ id: "status-body", children: ["status-fields", "status-notice", "status-footer"] })
    expect(noticeMessages("s", "status", { title: "x", text: "" }, true)).toHaveLength(1)
    expect(noticeMessages("s", "status", null, false)).toEqual([])
  })
})
